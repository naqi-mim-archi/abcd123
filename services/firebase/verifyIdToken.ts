import crypto from 'node:crypto';

// Verifies a Firebase ID token using only node:crypto.
//
// firebase-admin's verifyIdToken would do this, but it reaches jose@6 (ESM-only) through a
// require() inside jwks-rsa, and that combination refuses to load in the deployed Lambda —
// which meant every signed-in user was told to sign in. An ID token is a plain RS256 JWT
// signed by a well-known Google key, so checking it needs no dependency at all beyond
// fetching the public certificates.
//
// What is verified, in order: the signature against Google's published certificate for the
// token's `kid`, then issuer, audience, expiry and subject. Skipping any one of those is how
// token verification gets quietly turned into token decoding.

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface VerifiedToken {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

let cachedCerts: Record<string, string> | null = null;
let cachedUntil = 0;

const fetchCerts = async (): Promise<Record<string, string>> => {
  if (cachedCerts && Date.now() < cachedUntil) return cachedCerts;

  const response = await fetch(CERT_URL);
  if (!response.ok) throw new Error(`Could not fetch Google signing certificates (${response.status}).`);
  const certs = (await response.json()) as Record<string, string>;

  // Google says how long these are good for; honour it rather than re-fetching per request
  // or caching forever through a key rotation.
  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1];
  cachedUntil = Date.now() + (maxAge ? Number(maxAge) * 1000 : 60 * 60 * 1000);
  cachedCerts = certs;
  return certs;
};

const base64UrlDecode = (segment: string): Buffer =>
  Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Returns the verified caller, or throws with a reason. Callers decide whether a failure
 * means "not signed in" or "this server is broken" — the two are not the same and must not
 * be reported the same way.
 */
export const verifyFirebaseIdToken = async (
  token: string,
  projectId: string,
): Promise<VerifiedToken> => {
  if (!projectId) throw new Error('No Firebase project id configured on the server.');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = JSON.parse(base64UrlDecode(rawHeader).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error(`Unexpected token algorithm: ${header.alg}`);
  if (!header.kid) throw new Error('Token has no key id.');

  const certs = await fetchCerts();
  const cert = certs[header.kid];
  // An unknown kid usually means the key rotated since we cached; refetch once before
  // deciding the token is bad.
  const resolvedCert = cert ?? (await (async () => {
    cachedCerts = null;
    return (await fetchCerts())[header.kid];
  })());
  if (!resolvedCert) throw new Error('Token was signed with an unrecognised key.');

  const publicKey = new crypto.X509Certificate(resolvedCert).publicKey;
  const signatureValid = crypto
    .createVerify('RSA-SHA256')
    .update(`${rawHeader}.${rawPayload}`)
    .verify(publicKey, base64UrlDecode(rawSignature));
  if (!signatureValid) throw new Error('Token signature is not valid.');

  const payload = JSON.parse(base64UrlDecode(rawPayload).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);

  if (payload.aud !== projectId) {
    throw new Error(`Token was issued for a different Firebase project (${payload.aud}).`);
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error(`Unexpected token issuer: ${payload.iss}`);
  }
  // 60 seconds of slack, the same allowance firebase-admin makes for clock drift.
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) throw new Error('Token has expired.');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('Token is not valid yet.');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('Token has no subject.');

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: Boolean(payload.email_verified),
  };
};
