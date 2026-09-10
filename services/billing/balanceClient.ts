import { doc, onSnapshot, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { getFirebaseDb } from '../firebase/firebaseConfig';
import { FREE_STORAGE_BYTES, type TokenPack } from './pricing';

// Browser side of the ledger. Balances are read straight from Firestore so they update the
// instant a charge lands — the security rules make entitlements/{uid} readable by its owner
// and writable by nobody, so this is a live view of server-owned state, not a local tally.

/**
 * `status` matters more than it looks. A balance of 0 because the account has spent
 * everything and a balance of 0 because the read was denied are completely different
 * situations, and showing a confident "0" for the second is how a user with 100 tokens gets
 * told they have none. Anything other than 'ok' means the number is not to be trusted.
 */
export type BalanceStatus = 'loading' | 'ok' | 'missing' | 'unreadable';

export interface AccountBalance {
  tokenBalance: number;
  tokensGrantedLifetime: number;
  tokensSpentLifetime: number;
  storageBytesUsed: number;
  storageQuotaBytes: number;
  status: BalanceStatus;
}

const BLANK = {
  tokenBalance: 0,
  tokensGrantedLifetime: 0,
  tokensSpentLifetime: 0,
  storageBytesUsed: 0,
  storageQuotaBytes: FREE_STORAGE_BYTES,
};

export const EMPTY_BALANCE: AccountBalance = { ...BLANK, status: 'loading' };

/** The read was refused — almost always because firestore.rules has not been deployed. */
export const isBalanceUnreadable = (balance: AccountBalance): boolean => balance.status === 'unreadable';

/** Live subscription to the signed-in user's balance. Returns an unsubscribe function. */
export const watchAccountBalance = (
  userId: string,
  onChange: (balance: AccountBalance) => void,
): (() => void) => {
  const ref = doc(getFirebaseDb(), 'entitlements', userId);
  return onSnapshot(
    ref,
    snapshot => {
      if (!snapshot.exists()) {
        // The server creates the entitlement on first sight; until then there is genuinely
        // nothing to show, which is different from being unable to look.
        onChange({ ...BLANK, status: 'missing' });
        return;
      }
      const data = snapshot.data() as Record<string, any>;
      onChange({
        tokenBalance: Number(data.tokenBalance ?? 0),
        tokensGrantedLifetime: Number(data.tokensGrantedLifetime ?? 0),
        tokensSpentLifetime: Number(data.tokensSpentLifetime ?? 0),
        storageBytesUsed: Number(data.storageBytesUsed ?? 0),
        storageQuotaBytes: Number(data.storageQuotaBytes ?? FREE_STORAGE_BYTES),
        status: 'ok',
      });
    },
    error => {
      console.warn(
        'Could not read your token balance. If this is permission-denied, firestore.rules '
        + 'has probably not been deployed — run: firebase deploy --only firestore:rules',
        error,
      );
      onChange({ ...BLANK, status: 'unreadable' });
    },
  );
};

export interface LedgerEntry {
  id: string;
  type: 'grant' | 'spend' | 'refund' | 'purchase';
  amount: number;
  reason: string;
  detail: string | null;
  balanceAfter: number;
  createdAt: Date | null;
}

export const listRecentLedgerEntries = async (userId: string, count = 25): Promise<LedgerEntry[]> => {
  const ref = collection(getFirebaseDb(), 'entitlements', userId, 'ledger');
  const snapshot = await getDocs(query(ref, orderBy('createdAt', 'desc'), limit(count)));
  return snapshot.docs.map(entry => {
    const data = entry.data() as Record<string, any>;
    return {
      id: entry.id,
      type: data.type,
      amount: Number(data.amount ?? 0),
      reason: String(data.reason ?? ''),
      detail: data.detail ?? null,
      balanceAfter: Number(data.balanceAfter ?? 0),
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : null,
    };
  });
};

export interface AccountSummary {
  tokenBalance: number;
  storage: { usedBytes: number; quotaBytes: number; metered: boolean };
  packs: TokenPack[];
  actionPrices: Record<string, number>;
  paymentsEnabled: boolean;
}

/**
 * Asks the server for the authoritative figures. Worth calling when the tokens panel opens:
 * it creates the entitlement for a brand-new account and recomputes storage from the bucket,
 * neither of which the browser can do for itself.
 */
export const fetchAccountSummary = async (): Promise<AccountSummary> => {
  const response = await fetch('/api/billing/account');
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not load your account.');
  return response.json();
};

/** Asks whether a save of this size fits in the remaining storage quota. */
export const checkStorageAllowance = async (
  additionalBytes: number,
): Promise<{ allowed: boolean; usedBytes: number; quotaBytes: number; metered: boolean; message?: string }> => {
  const response = await fetch('/api/billing/storage/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ additionalBytes }),
  });
  if (!response.ok) {
    // A metering outage must not block someone from saving their work.
    return { allowed: true, usedBytes: 0, quotaBytes: FREE_STORAGE_BYTES, metered: false };
  }
  return response.json();
};

/** Starts Stripe Checkout and hands back the URL to send the buyer to. */
export const startCheckout = async (packId: string, email: string | null): Promise<string> => {
  const response = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packId, email }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
  return data.url as string;
};
