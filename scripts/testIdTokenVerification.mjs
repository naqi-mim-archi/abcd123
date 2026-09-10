// Verifies the hand-rolled Firebase ID token check against real tokens.
//
// This code replaced firebase-admin's verifyIdToken (whose dependency chain would not load
// in the deployed Lambda), so it is the only thing standing between an attacker and every
// authenticated route. A signature check that accepts a tampered token is worse than none,
// because it looks like security. Hence the negative cases below.
//
// Needs FIREBASE_ADMIN_SA_KEY_JSON and VITE_FIREBASE_API_KEY; skips cleanly without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';

for (const file of ['.env.local', '.env']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=([\s\S]*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!process.env.FIREBASE_ADMIN_SA_KEY_JSON || !process.env.VITE_FIREBASE_API_KEY) {
  console.log('Skipping: needs FIREBASE_ADMIN_SA_KEY_JSON and VITE_FIREBASE_API_KEY.');
  process.exit(0);
}

const out = await build({
  entryPoints: ['services/firebase/verifyIdToken.ts'],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
fs.writeFileSync('node_modules/.verify-token-test.mjs', out.outputFiles[0].text);
const { verifyFirebaseIdToken } = await import('../node_modules/.verify-token-test.mjs');

let raw = process.env.FIREBASE_ADMIN_SA_KEY_JSON.trim();
if (!raw.startsWith('{')) raw = raw.slice(1, -1);
const credentials = JSON.parse(raw);
const projectId = credentials.project_id;
const UID = 'zz-token-verification-test';

const { initializeApp, cert } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const app = initializeApp({ credential: cert(credentials), projectId }, `test-${Date.now()}`);

const customToken = await getAuth(app).createCustomToken(UID);
const exchanged = await (await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.VITE_FIREBASE_API_KEY}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }) })).json();
const idToken = exchanged.idToken;
assert.ok(idToken, 'could not mint a test ID token');

const rejects = async (token, pid, what) => {
  await assert.rejects(() => verifyFirebaseIdToken(token, pid), what);
};

// --- the happy path ----------------------------------------------------------
const verified = await verifyFirebaseIdToken(idToken, projectId);
assert.equal(verified.uid, UID, 'a genuine token must verify and yield its subject');
console.log('  genuine token accepted, uid =', verified.uid);

// --- tampering ---------------------------------------------------------------
const [h, p, s] = idToken.split('.');
const decode = seg => JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

// Swapping the subject for someone else's uid, keeping the original signature.
const forged = { ...decode(p), sub: 'victim-uid' };
await rejects(`${h}.${encode(forged)}.${s}`, projectId, /signature is not valid/i);
console.log('  tampered subject rejected');

// "alg": "none", the classic JWT bypass.
await rejects(`${encode({ alg: 'none', kid: decode(h).kid })}.${p}.`, projectId, /algorithm/i);
console.log('  alg=none rejected');

// A token minted for a different Firebase project must not be accepted here.
await rejects(idToken, 'some-other-project', /different Firebase project|issuer/i);
console.log('  wrong-project token rejected');

// An expired token.
const expired = { ...decode(p), exp: Math.floor(Date.now() / 1000) - 3600 };
await rejects(`${h}.${encode(expired)}.${s}`, projectId, /signature is not valid/i);
console.log('  expired (and therefore re-signed) token rejected');

await rejects('not.a.token', projectId, /./);
await rejects('garbage', projectId, /Malformed/i);
console.log('  malformed tokens rejected');

await getAuth(app).deleteUser(UID).catch(() => {});
fs.rmSync('node_modules/.verify-token-test.mjs', { force: true });
console.log('\nID token verification tests passed.');
