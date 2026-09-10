// Owns the single firebase-admin app the server side shares between ID-token verification
// (adminAuth.ts), the token ledger (services/billing/tokenLedger.ts) and storage metering.
// Node-only — never import this from a module the client bundle can reach.

const APP_NAME = 'archai-api';

// Same packaging problem vertexAuth.ts documents: a JSON blob pasted into a shell or a
// dashboard field often keeps the quotes that were wrapping it, and JSON.parse then fails
// with an opaque error. A service-account key is always an object, so a leading quote can
// only be packaging.
const unwrapQuoted = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length <= 1 || trimmed.startsWith('{')) return trimmed;
  const first = trimmed[0];
  if ((first === "'" || first === '"') && trimmed.endsWith(first)) return trimmed.slice(1, -1);
  return trimmed;
};

let serviceAccountParseError: string | null = null;

const readServiceAccount = (): Record<string, any> | null => {
  const raw = process.env.FIREBASE_ADMIN_SA_KEY_JSON;
  if (!raw || !raw.trim()) {
    serviceAccountParseError = 'FIREBASE_ADMIN_SA_KEY_JSON is not set.';
    return null;
  }
  try {
    const parsed = JSON.parse(unwrapQuoted(raw));
    serviceAccountParseError = null;
    return parsed;
  } catch (error: any) {
    // By far the most common cause: pasting the key somewhere that turned the \n escapes
    // inside private_key into real newlines, which is no longer valid JSON.
    serviceAccountParseError =
      `FIREBASE_ADMIN_SA_KEY_JSON is not valid JSON (${error?.message}). `
      + 'This usually means the \\n escapes inside private_key were converted to real line breaks.';
    console.error(serviceAccountParseError);
    return null;
  }
};

export const resolveProjectId = (): string =>
  process.env.FIREBASE_PROJECT_ID
  || process.env.VITE_FIREBASE_PROJECT_ID
  || process.env.GOOGLE_CLOUD_PROJECT
  || readServiceAccount()?.project_id
  || '';

export const resolveStorageBucket = (): string =>
  process.env.FIREBASE_STORAGE_BUCKET
  || process.env.VITE_FIREBASE_STORAGE_BUCKET
  || (resolveProjectId() ? `${resolveProjectId()}.appspot.com` : '');

/**
 * True when a service-account key is present. Verifying an ID token does not need one —
 * signatures are checked against Google's public certs — but reading or writing Firestore
 * and listing Storage as an administrator both do.
 */
export const hasAdminCredentials = (): boolean => readServiceAccount() !== null;

let appPromise: Promise<any> | null = null;

/** What the server can and cannot do, for diagnosing a deployment. Reveals no secrets. */
export const getAdminConfigStatus = () => {
  const serviceAccount = readServiceAccount();
  return {
    projectId: resolveProjectId() || null,
    hasServiceAccount: serviceAccount !== null,
    serviceAccountEmail: serviceAccount?.client_email ?? null,
    serviceAccountProjectId: serviceAccount?.project_id ?? null,
    error: serviceAccountParseError,
  };
};

export const getAdminApp = async (): Promise<any | null> => {
  if (appPromise) return appPromise;

  const projectId = resolveProjectId();
  const serviceAccount = readServiceAccount();
  if (!projectId && !serviceAccount) return null;

  appPromise = (async () => {
    const { cert, getApps, initializeApp } = await import('firebase-admin/app');
    const existing = getApps().find((app: any) => app.name === APP_NAME);
    if (existing) return existing;

    const options: Record<string, unknown> = { projectId };
    if (serviceAccount) options.credential = cert(serviceAccount);
    const bucket = resolveStorageBucket();
    if (bucket) options.storageBucket = bucket;

    return initializeApp(options, APP_NAME);
  })();

  // A rejected promise left in the cache would make one bad startup permanent for the
  // lifetime of the warm function, turning a transient failure into a lasting one.
  appPromise.catch(() => {
    appPromise = null;
  });

  return appPromise;
};

export const getAdminAuth = async (): Promise<any | null> => {
  const app = await getAdminApp();
  if (!app) return null;
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(app);
};

/** Null without a service-account key — Firestore admin access cannot work on project id alone. */
export const getAdminFirestore = async (): Promise<any | null> => {
  if (!hasAdminCredentials()) return null;
  const app = await getAdminApp();
  if (!app) return null;
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore(app);
};

/** Null without a service-account key, same as Firestore. */
export const getAdminStorageBucket = async (): Promise<any | null> => {
  if (!hasAdminCredentials()) return null;
  const app = await getAdminApp();
  if (!app) return null;
  const { getStorage } = await import('firebase-admin/storage');
  const bucketName = resolveStorageBucket();
  return bucketName ? getStorage(app).bucket(bucketName) : getStorage(app).bucket();
};
