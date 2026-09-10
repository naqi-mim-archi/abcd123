// Exercises the token ledger against an in-memory stand-in for Firestore.
//
// The risky parts of billing are not arithmetic, they are the edges: a request replayed by
// a flaky network must not charge twice, a Stripe webhook delivered twice must not credit
// twice, and a refund must never be able to mint tokens that were not taken. Those are the
// cases below.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// --- A Firestore small enough to reason about --------------------------------
const makeFakeFirestore = () => {
  const docs = new Map();
  const stats = { transactions: 0 };

  const makeRef = path => ({
    path,
    collection: name => ({ doc: id => makeRef(`${path}/${name}/${id}`) }),
    async set(data, options) {
      const existing = options?.merge ? docs.get(path) || {} : {};
      docs.set(path, { ...existing, ...data });
    },
  });

  return {
    docs,
    stats,
    collection: name => ({ doc: id => makeRef(`${name}/${id}`) }),
    async runTransaction(fn) {
      stats.transactions += 1;
      // Buffer writes and apply them at the end, the way a real transaction does — so a
      // transaction that returns early cannot leave a partial write behind.
      const pending = [];
      let hasWritten = false;
      const tx = {
        async get(ref) {
          // Firestore rejects a transaction that reads after it has written. Catching that
          // here is the point: a real deployment would fail at runtime, not in a unit test.
          assert.equal(hasWritten, false, 'A transaction must do all its reads before any write.');
          const data = docs.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref, data, options) {
          hasWritten = true;
          pending.push({ ref, data, options });
        },
      };
      const result = await fn(tx);
      for (const write of pending) {
        const existing = write.options?.merge ? docs.get(write.ref.path) || {} : {};
        docs.set(write.ref.path, { ...existing, ...write.data });
      }
      return result;
    },
  };
};

const fakeDb = makeFakeFirestore();

const stubFirestoreModule = `
  export const FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true }) };
`;

const stubAdminApp = `
  export const hasAdminCredentials = () => true;
  export const getAdminFirestore = async () => globalThis.__fakeDb;
  export const getAdminStorageBucket = async () => null;
  export const getAdminApp = async () => ({});
  export const getAdminAuth = async () => null;
  export const resolveProjectId = () => 'test-project';
  export const resolveStorageBucket = () => 'test-bucket';
`;

const result = await build({
  entryPoints: ['services/billing/tokenLedger.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      // The bundle is imported from a data: URL, which cannot resolve bare specifiers, so
      // both the admin app and firebase-admin's FieldValue sentinels are stubbed in. The
      // sentinels are opaque values as far as the ledger is concerned.
      name: 'stub-admin',
      setup(builder) {
        builder.onResolve({ filter: /firebase\/adminApp$/ }, () => ({
          path: 'admin-app',
          namespace: 'stub',
        }));
        builder.onResolve({ filter: /^firebase-admin\/firestore$/ }, () => ({
          path: 'firestore',
          namespace: 'stub',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: args.path === 'admin-app' ? stubAdminApp : stubFirestoreModule,
          loader: 'js',
        }));
      },
    },
  ],
});

globalThis.__fakeDb = fakeDb;
const ledger = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const balanceOf = uid => fakeDb.docs.get(`entitlements/${uid}`)?.tokenBalance;
const ledgerEntry = (uid, id) => fakeDb.docs.get(`entitlements/${uid}/ledger/${id}`);

// --- Signup grant ------------------------------------------------------------
const alice = await ledger.ensureEntitlement('alice');
assert.equal(alice.tokenBalance, 100, 'A new account starts with 100 tokens.');
assert.equal(ledgerEntry('alice', 'signup-grant').amount, 100, 'The grant is recorded on the ledger.');

// Seeing the same account again must not grant a second time.
await ledger.ensureEntitlement('alice');
assert.equal(balanceOf('alice'), 100, 'The signup grant is given once, not on every sight.');

// --- Spending ----------------------------------------------------------------
const generation = await ledger.spendTokens('alice', {
  amount: 25,
  reason: 'floorplan-generation',
  requestId: 'req-gen-1',
  detail: 'Floorplan generation',
});
assert.equal(generation.ok, true);
assert.equal(generation.balance, 75);
assert.equal(ledgerEntry('alice', 'req-gen-1').amount, -25, 'A charge is recorded as a negative amount.');

const conversion = await ledger.spendTokens('alice', {
  amount: 25,
  reason: 'floorplan-conversion',
  requestId: 'req-conv-1',
  detail: 'Floorplan conversion',
});
assert.equal(conversion.balance, 50, 'Generate + convert takes 50 in total.');

// --- Replay protection -------------------------------------------------------
const replayed = await ledger.spendTokens('alice', {
  amount: 25,
  reason: 'floorplan-generation',
  requestId: 'req-gen-1',
  detail: 'Floorplan generation',
});
assert.equal(replayed.replayed, true, 'A repeated request id is recognised as a replay.');
assert.equal(balanceOf('alice'), 50, 'Replaying a request must not charge again.');

// --- Running out -------------------------------------------------------------
const tooExpensive = await ledger.spendTokens('alice', {
  amount: 100,
  reason: 'ai-render',
  requestId: 'req-render-toobig',
  detail: 'AI render',
});
assert.equal(tooExpensive.ok, false, 'A charge beyond the balance is refused.');
assert.equal(tooExpensive.required, 100);
assert.equal(tooExpensive.balance, 50);
assert.equal(balanceOf('alice'), 50, 'A refused charge must leave the balance untouched.');
assert.equal(ledgerEntry('alice', 'req-render-toobig'), undefined, 'A refused charge writes no ledger entry.');

// --- Refunds -----------------------------------------------------------------
await ledger.refundTokens('alice', { amount: 25, reason: 'floorplan-generation', requestId: 'req-gen-1' });
assert.equal(balanceOf('alice'), 75, 'A refund returns what was charged.');

// A second failure signal for the same job must not pay out twice.
await ledger.refundTokens('alice', { amount: 25, reason: 'floorplan-generation', requestId: 'req-gen-1' });
assert.equal(balanceOf('alice'), 75, 'Refunding twice must not mint tokens.');

// Refunding something that was never charged must do nothing at all.
await ledger.refundTokens('alice', { amount: 500, reason: 'ai-render', requestId: 'req-never-happened' });
assert.equal(balanceOf('alice'), 75, 'Refunding an uncharged request must not mint tokens.');

// A caller that overstates the amount only gets back what was actually taken.
await ledger.spendTokens('alice', {
  amount: 25,
  reason: 'floorplan-conversion',
  requestId: 'req-conv-2',
  detail: 'Floorplan conversion',
});
assert.equal(balanceOf('alice'), 50);
await ledger.refundTokens('alice', { amount: 9999, reason: 'floorplan-conversion', requestId: 'req-conv-2' });
assert.equal(balanceOf('alice'), 75, 'A refund is capped at what the charge actually took.');

// --- Purchases ---------------------------------------------------------------
const afterPurchase = await ledger.creditTokens('alice', {
  amount: 500,
  requestId: 'stripe-evt_test_1',
  detail: 'Purchased 500 tokens ($25.99)',
});
assert.equal(afterPurchase, 575, 'A purchase credits the balance.');

// Stripe retries deliveries; the same event must never credit twice.
const afterReplay = await ledger.creditTokens('alice', {
  amount: 500,
  requestId: 'stripe-evt_test_1',
  detail: 'Purchased 500 tokens ($25.99)',
});
assert.equal(afterReplay, 575, 'A replayed Stripe event must not credit again.');
assert.equal(balanceOf('alice'), 575);

// --- Charging an account we have never seen ----------------------------------
// The grant and the charge have to happen together, or the first thing a new user does
// would fail for want of a balance that was about to be created.
const bobSpend = await ledger.spendTokens('bob', {
  amount: 50,
  reason: 'ai-render',
  requestId: 'req-bob-1',
  detail: 'AI render',
});
assert.equal(bobSpend.ok, true, 'A brand-new account can spend its signup grant immediately.');
assert.equal(bobSpend.balance, 50, 'Bob was granted 100 and charged 50 in one transaction.');
assert.equal(ledgerEntry('bob', 'signup-grant').amount, 100);

// --- Everything that moves a balance does so in a transaction ----------------
assert.ok(fakeDb.stats.transactions > 0, 'Balance changes go through runTransaction.');

console.log('Token ledger tests passed.');
