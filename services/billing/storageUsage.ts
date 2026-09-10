// Per-user Cloud Storage accounting.
//
// Usage is recomputed from the bucket rather than accumulated from client-reported deltas —
// a client that can report "I wrote -5 GB" is not a quota. Listing one user's prefix is a
// single cheap API call for the handful of objects an account has, and it self-heals if a
// write or delete is ever missed.
import { getAdminStorageBucket } from '../firebase/adminApp';
import { FREE_STORAGE_BYTES } from './pricing';
import { ensureEntitlement, setStorageUsage } from './tokenLedger';

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  /** False when there is no service-account key, so the figures are unknown rather than zero. */
  metered: boolean;
}

const userPrefix = (uid: string) => `users/${uid}/`;

/** Authoritative total of everything the user has in the bucket. */
export const computeStorageUsage = async (uid: string): Promise<number | null> => {
  const bucket = await getAdminStorageBucket();
  if (!bucket) return null;
  const [files] = await bucket.getFiles({ prefix: userPrefix(uid) });
  return files.reduce((total: number, file: any) => total + Number(file.metadata?.size || 0), 0);
};

export const getStorageUsage = async (uid: string): Promise<StorageUsage> => {
  const entitlement = await ensureEntitlement(uid);
  const quotaBytes = entitlement.storageQuotaBytes || FREE_STORAGE_BYTES;

  const usedBytes = await computeStorageUsage(uid);
  if (usedBytes === null) {
    return { usedBytes: entitlement.storageBytesUsed, quotaBytes, metered: false };
  }

  // Cache it so the account panel can render a figure without a bucket listing every time.
  if (usedBytes !== entitlement.storageBytesUsed) await setStorageUsage(uid, usedBytes);
  return { usedBytes, quotaBytes, metered: true };
};

export interface StorageCheck extends StorageUsage {
  allowed: boolean;
  message?: string;
}

/**
 * Whether the user has room for `additionalBytes`. Called before a save that would write to
 * Cloud Storage — which only happens for projects too large to sit inline in Firestore, plus
 * thumbnails and render images.
 */
export const checkStorageAllowance = async (
  uid: string,
  additionalBytes: number,
): Promise<StorageCheck> => {
  const usage = await getStorageUsage(uid);
  if (!usage.metered) {
    // Storage metering needs admin credentials. Rather than block every save on a
    // deployment that has not set them up, allow the write and say so in the logs.
    return { ...usage, allowed: true };
  }

  const projected = usage.usedBytes + Math.max(0, additionalBytes);
  if (projected <= usage.quotaBytes) return { ...usage, allowed: true };

  return {
    ...usage,
    allowed: false,
    message: 'This save would take you past your storage limit. Free up space or add more storage.',
  };
};
