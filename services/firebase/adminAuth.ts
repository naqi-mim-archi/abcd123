// Server-side verification of the Firebase ID token that apiAuthInterceptor.ts attaches to
// every /api/* request. Runs inside the Vercel function (and vite.config.js's dev
// middleware) — never in the browser. firebase-admin is a node-only package and must not be
// imported from any module the client bundle can reach.
import type { VercelRequest } from '@vercel/node';
import { getAdminAuth, resolveProjectId } from './adminApp';

export interface ApiUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

const readBearerToken = (req: { headers?: Record<string, any> }): string | null => {
  const header = req.headers?.authorization || req.headers?.Authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
};

/**
 * Returns the caller, or null when the request carries no usable token. Never throws — an
 * unverifiable token is indistinguishable from an absent one as far as the caller is
 * concerned, and both mean 401.
 *
 * Verification needs only the project id: the signature is checked against Google's public
 * certs, fetched anonymously. A service-account key is required for the token ledger and
 * storage metering, not for this.
 */
export const verifyApiRequestUser = async (
  req: VercelRequest | { headers?: Record<string, any> },
): Promise<ApiUser | null> => {
  const token = readBearerToken(req as any);
  if (!token) return null;

  try {
    const auth = await getAdminAuth();
    if (!auth) return null;
    const decoded = await auth.verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: Boolean(decoded.email_verified),
    };
  } catch {
    // Expired, malformed, wrong-project or revoked — all just "not signed in".
    return null;
  }
};

/** Why verification cannot run at all, for logging. Null once a project id is present. */
export const getApiAuthConfigError = (): string | null =>
  resolveProjectId()
    ? null
    : 'Firebase is not configured on the server: set FIREBASE_PROJECT_ID (or FIREBASE_ADMIN_SA_KEY_JSON).';

/**
 * Dev escape hatch: `vite dev` has no signed-in user until someone signs in, so
 * ALLOW_ANONYMOUS_API=1 makes the routes serve anonymous callers locally. Production must
 * never set it — with it on, anyone who knows the deployment URL can spend the project's
 * Gemini/Vertex/APS quota.
 */
export const isAnonymousApiAllowed = (): boolean => {
  const raw = (process.env.ALLOW_ANONYMOUS_API || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

export const API_AUTH_REQUIRED_MESSAGE = 'Sign in to use this feature.';
