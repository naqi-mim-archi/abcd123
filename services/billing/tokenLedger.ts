// The token ledger. Server-only: it writes `entitlements/{uid}`, which the security rules
// make unwritable from any client, so a balance can only ever change through this file.
//
// Two invariants matter here:
//  - Every balance change happens inside a Firestore transaction. Without that, firing two
//    generations at once would read the same balance twice and spend it twice.
//  - Every change is idempotent on `requestId`. A retried request, a Vercel function
//    replay, or a Stripe webhook delivered twice must not charge or credit twice.
import { getAdminFirestore, hasAdminCredentials } from '../firebase/adminApp';
import { SIGNUP_GRANT_TOKENS, FREE_STORAGE_BYTES, type SpendReason } from './pricing';

export interface Entitlement {
  tokenBalance: number;
  tokensGrantedLifetime: number;
  tokensSpentLifetime: number;
  storageBytesUsed: number;
  storageQuotaBytes: number;
  signupGrantedAt: any | null;
}

export type LedgerEntryType = 'grant' | 'spend' | 'refund' | 'purchase';

export interface SpendResult {
  ok: boolean;
  balance: number;
  /** Present when ok is false: how many tokens the action needed. */
  required?: number;
  /** True when an entry with this requestId already existed, so nothing was charged again. */
  replayed?: boolean;
}

const entitlementRef = (db: any, uid: string) => db.collection('entitlements').doc(uid);
const ledgerRef = (db: any, uid: string, entryId: string) =>
  entitlementRef(db, uid).collection('ledger').doc(entryId);

const DEFAULT_ENTITLEMENT = (): Omit<Entitlement, 'signupGrantedAt'> => ({
  tokenBalance: SIGNUP_GRANT_TOKENS,
  tokensGrantedLifetime: SIGNUP_GRANT_TOKENS,
  tokensSpentLifetime: 0,
  storageBytesUsed: 0,
  storageQuotaBytes: FREE_STORAGE_BYTES,
});

/**
 * Billing cannot run without a service-account key, because the ledger lives in Firestore
 * and admin Firestore access needs real credentials (a project id alone is enough to verify
 * a token, but not to read a document).
 *
 * When the key is missing we fail *closed* — the whole point of metering is that AI calls
 * cost money, so an unconfigured deployment must not quietly hand them out for free. Set
 * ALLOW_UNMETERED_API=1 to deliberately turn metering off instead.
 */
export const isBillingConfigured = (): boolean => hasAdminCredentials();

export const isUnmeteredApiAllowed = (): boolean => {
  const raw = (process.env.ALLOW_UNMETERED_API || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

export const BILLING_UNCONFIGURED_MESSAGE =
  'Billing is not configured on the server. Set FIREBASE_ADMIN_SA_KEY_JSON (or ALLOW_UNMETERED_API=1 to run without metering).';

const toEntitlement = (data: any): Entitlement => ({
  tokenBalance: Number(data?.tokenBalance ?? 0),
  tokensGrantedLifetime: Number(data?.tokensGrantedLifetime ?? 0),
  tokensSpentLifetime: Number(data?.tokensSpentLifetime ?? 0),
  storageBytesUsed: Number(data?.storageBytesUsed ?? 0),
  storageQuotaBytes: Number(data?.storageQuotaBytes ?? FREE_STORAGE_BYTES),
  signupGrantedAt: data?.signupGrantedAt ?? null,
});

/**
 * Reads the caller's entitlement, creating it with the signup grant the first time we see
 * them. "First sight" rather than "at sign-up" so accounts that predate billing are not
 * stranded at zero.
 */
export const ensureEntitlement = async (uid: string): Promise<Entitlement> => {
  const db = await getAdminFirestore();
  if (!db) throw new Error(BILLING_UNCONFIGURED_MESSAGE);

  const { FieldValue } = await import('firebase-admin/firestore');
  const ref = entitlementRef(db, uid);

  return db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (snap.exists) return toEntitlement(snap.data());

    const created = { ...DEFAULT_ENTITLEMENT(), signupGrantedAt: FieldValue.serverTimestamp() };
    tx.set(ref, { ...created, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.set(ledgerRef(db, uid, `signup-grant`), {
      type: 'grant' as LedgerEntryType,
      amount: SIGNUP_GRANT_TOKENS,
      reason: 'signup-grant',
      balanceAfter: SIGNUP_GRANT_TOKENS,
      createdAt: FieldValue.serverTimestamp(),
    });
    return toEntitlement(created);
  });
};

/**
 * Debits `amount` tokens, or reports the shortfall without charging anything.
 * `requestId` makes the charge idempotent — pass something stable for the request.
 */
export const spendTokens = async (
  uid: string,
  options: { amount: number; reason: SpendReason; requestId: string; detail?: string },
): Promise<SpendResult> => {
  const { amount, reason, requestId, detail } = options;
  const db = await getAdminFirestore();
  if (!db) throw new Error(BILLING_UNCONFIGURED_MESSAGE);
  if (amount <= 0) return { ok: true, balance: (await ensureEntitlement(uid)).tokenBalance };

  const { FieldValue } = await import('firebase-admin/firestore');
  const ref = entitlementRef(db, uid);
  const entry = ledgerRef(db, uid, requestId);

  return db.runTransaction(async (tx: any) => {
    // Both reads must happen before any write — Firestore transactions require it.
    const [snap, entrySnap] = await Promise.all([tx.get(ref), tx.get(entry)]);

    if (entrySnap.exists) {
      const current = snap.exists ? toEntitlement(snap.data()) : DEFAULT_ENTITLEMENT();
      return { ok: true, balance: current.tokenBalance, replayed: true };
    }

    let existing: Entitlement;
    if (snap.exists) {
      existing = toEntitlement(snap.data());
    } else {
      // First sight and a charge in the same breath: grant, then charge against the grant.
      existing = { ...DEFAULT_ENTITLEMENT(), signupGrantedAt: FieldValue.serverTimestamp() };
      tx.set(ref, { ...existing, createdAt: FieldValue.serverTimestamp() });
      tx.set(ledgerRef(db, uid, 'signup-grant'), {
        type: 'grant' as LedgerEntryType,
        amount: SIGNUP_GRANT_TOKENS,
        reason: 'signup-grant',
        balanceAfter: SIGNUP_GRANT_TOKENS,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    if (existing.tokenBalance < amount) {
      return { ok: false, balance: existing.tokenBalance, required: amount };
    }

    const balanceAfter = existing.tokenBalance - amount;
    tx.set(
      ref,
      {
        tokenBalance: balanceAfter,
        tokensSpentLifetime: existing.tokensSpentLifetime + amount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(entry, {
      type: 'spend' as LedgerEntryType,
      amount: -amount,
      reason,
      detail: detail ?? null,
      balanceAfter,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, balance: balanceAfter };
  });
};

/**
 * Puts tokens back. Used when the work a charge paid for did not happen — the route threw,
 * or an AI-render job later failed or was cancelled. Idempotent per `requestId`, and it
 * refuses to refund a charge that was never made or was already refunded, so a double
 * failure signal cannot mint tokens.
 */
export const refundTokens = async (
  uid: string,
  options: { amount: number; reason: SpendReason; requestId: string; detail?: string },
): Promise<void> => {
  const { amount, reason, requestId, detail } = options;
  if (amount <= 0) return;
  const db = await getAdminFirestore();
  if (!db) return;

  const { FieldValue } = await import('firebase-admin/firestore');
  const ref = entitlementRef(db, uid);
  const spendEntry = ledgerRef(db, uid, requestId);
  const refundEntry = ledgerRef(db, uid, `${requestId}:refund`);

  await db.runTransaction(async (tx: any) => {
    const [snap, spendSnap, refundSnap] = await Promise.all([
      tx.get(ref),
      tx.get(spendEntry),
      tx.get(refundEntry),
    ]);

    // Nothing was charged, or this refund already ran.
    if (!snap.exists || !spendSnap.exists || refundSnap.exists) return;
    // Only refund what was actually taken, whatever the caller claims.
    const charged = Math.abs(Number(spendSnap.data()?.amount ?? 0));
    if (charged <= 0) return;

    const existing = toEntitlement(snap.data());
    const balanceAfter = existing.tokenBalance + charged;
    tx.set(
      ref,
      {
        tokenBalance: balanceAfter,
        tokensSpentLifetime: Math.max(0, existing.tokensSpentLifetime - charged),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(refundEntry, {
      type: 'refund' as LedgerEntryType,
      amount: charged,
      reason,
      detail: detail ?? 'Refunded: the work did not complete.',
      balanceAfter,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
};

/** Credits a purchase. `requestId` should be the Stripe event id so a replay cannot double-credit. */
export const creditTokens = async (
  uid: string,
  options: { amount: number; requestId: string; detail: string },
): Promise<number> => {
  const { amount, requestId, detail } = options;
  const db = await getAdminFirestore();
  if (!db) throw new Error(BILLING_UNCONFIGURED_MESSAGE);

  const { FieldValue } = await import('firebase-admin/firestore');
  const ref = entitlementRef(db, uid);
  const entry = ledgerRef(db, uid, requestId);

  return db.runTransaction(async (tx: any) => {
    const [snap, entrySnap] = await Promise.all([tx.get(ref), tx.get(entry)]);
    const existing = snap.exists
      ? toEntitlement(snap.data())
      : { ...DEFAULT_ENTITLEMENT(), signupGrantedAt: null };

    if (entrySnap.exists) return existing.tokenBalance;

    const balanceAfter = existing.tokenBalance + amount;
    tx.set(
      ref,
      {
        ...(snap.exists ? {} : { ...existing, createdAt: FieldValue.serverTimestamp() }),
        tokenBalance: balanceAfter,
        tokensGrantedLifetime: existing.tokensGrantedLifetime + amount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(entry, {
      type: 'purchase' as LedgerEntryType,
      amount,
      reason: 'purchase',
      detail,
      balanceAfter,
      createdAt: FieldValue.serverTimestamp(),
    });
    return balanceAfter;
  });
};

export const setStorageUsage = async (uid: string, usedBytes: number): Promise<void> => {
  const db = await getAdminFirestore();
  if (!db) return;
  const { FieldValue } = await import('firebase-admin/firestore');
  await entitlementRef(db, uid).set(
    { storageBytesUsed: usedBytes, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
};
