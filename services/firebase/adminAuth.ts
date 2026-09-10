// Server-side verification of the Firebase ID token that apiAuthInterceptor.ts attaches to
// every /api/* request. Runs inside the Vercel function (and vite.config.js's dev
// middleware) — never in the browser. firebase-admin is a node-only package and must not be
// imported from any module the client bundle can reach.
import type { VercelRequest } from '@vercel/node';
import { resolveProjectId } from './adminApp';
import { verifyFirebaseIdToken } from './verifyIdToken';

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
 * Why a request has no verified caller. These are not interchangeable: `no-token` is a user
 * who is not signed in, `server-unconfigured` is a deployment problem that has nothing to do
 * with the user, and answering both with the same "please sign in" makes a misconfigured
 * server impossible to tell apart from a signed-out visitor.
 */
export type AuthFailure = 'no-token' | 'invalid-token' | 'server-unconfigured';

export interface AuthResult {
  user: ApiUser | null;
  failure: AuthFailure | null;
  /** Safe to log and to return to the caller — never contains the token or the key. */
  detail?: string;
}

/**
 * Verification needs only the project id: the signature is checked against Google's public
 * certs, fetched anonymously. A service-account key is required for the token ledger and
 * storage metering, not for this — but if the key is present and malformed, initialising the
 * admin app fails and takes verification down with it, which is exactly the case this
 * reports as `server-unconfigured` rather than blaming the user.
 */
export const verifyApiRequest = async (
  req: VercelRequest | { headers?: Record<string, any> },
): Promise<AuthResult> => {
  const token = readBearerToken(req as any);
  if (!token) return { user: null, failure: 'no-token' };

  const projectId = resolveProjectId();
  if (!projectId) {
    const detail = getApiAuthConfigError() || 'Firebase is not configured on the server.';
    console.error('[api-auth] cannot verify tokens:', detail);
    return { user: null, failure: 'server-unconfigured', detail };
  }

  try {
    return { user: await verifyFirebaseIdToken(token, projectId), failure: null };
  } catch (error: any) {
    const message = String(error?.message || error);
    // Not being able to reach Google's certificates, or being pointed at the wrong project,
    // is a server problem wearing a user's clothes: the token is fine, this deployment
    // cannot check it. Saying "please sign in" to those would send someone chasing their
    // own account for a fault that is not theirs.
    const isServerFault = /certificate|project id configured|unrecognised key/i.test(message);
    if (isServerFault) {
      console.error('[api-auth] cannot verify tokens:', message);
      return { user: null, failure: 'server-unconfigured', detail: message };
    }
    console.warn('[api-auth] token rejected:', message);
    return { user: null, failure: 'invalid-token', detail: message };
  }
};

/** Back-compat wrapper for callers that only need the user. */
export const verifyApiRequestUser = async (
  req: VercelRequest | { headers?: Record<string, any> },
): Promise<ApiUser | null> => (await verifyApiRequest(req)).user;

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
