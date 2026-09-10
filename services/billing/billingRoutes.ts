// The /api/billing/* routes: what the account has, and how to buy more.
// These are free to call — resolveRouteCharge() never matches them.
import { ensureEntitlement, isBillingConfigured, BILLING_UNCONFIGURED_MESSAGE } from './tokenLedger';
import { getStorageUsage, checkStorageAllowance } from './storageUsage';
import { createCheckoutSession, isStripeConfigured } from './stripeClient';
import { TOKEN_PACKS, ACTION_PRICES, SIGNUP_GRANT_TOKENS } from './pricing';
import { getAdminConfigStatus } from '../firebase/adminApp';

interface BillingApiRequest {
  method?: string;
  url?: string;
  body?: any;
  userId?: string | null;
  headers?: Record<string, any>;
}

interface BillingApiResponse {
  status(code: number): any;
  json(payload: any): void;
}

const stripQuery = (url: string): string => url.split('?')[0].replace(/\/+$/, '') || '/';

export const routeBillingApiRequest = async (
  request: BillingApiRequest,
  response: BillingApiResponse,
): Promise<boolean> => {
  const url = String(request.url || '');
  if (!url.startsWith('/api/billing')) return false;

  const path = stripQuery(url);
  const method = String(request.method || 'GET').toUpperCase();
  const uid = request.userId ?? null;

  // Static pricing — safe to serve without an account so a signed-out visitor could be
  // shown what things cost.
  if (path === '/api/billing/pricing' && method === 'GET') {
    // `server` reports whether this deployment is wired up at all. It is deliberately
    // included on the one public route: without it, a missing or malformed service-account
    // key is invisible from outside and looks exactly like every user being signed out.
    // It exposes no secrets — only whether a key parsed, and which account it names.
    const config = getAdminConfigStatus();
    response.status(200).json({
      packs: TOKEN_PACKS,
      actionPrices: ACTION_PRICES,
      signupGrant: SIGNUP_GRANT_TOKENS,
      paymentsEnabled: isStripeConfigured(),
      server: {
        projectId: config.projectId,
        canVerifySignIn: Boolean(config.projectId),
        canMeterTokens: config.hasServiceAccount,
        serviceAccount: config.serviceAccountEmail,
        serviceAccountProjectId: config.serviceAccountProjectId,
        configError: config.error,
        // firebase-admin reaches jose@6 (ESM) through a require() in jwks-rsa, which only
        // works on Node 22.12+. Reported here because "works locally, 503 in production"
        // is otherwise a very long afternoon.
        nodeVersion: typeof process !== 'undefined' ? process.version : null,
      },
    });
    return true;
  }

  if (!uid) {
    response.status(401).json({ error: 'Sign in to use this feature.' });
    return true;
  }
  if (!isBillingConfigured()) {
    response.status(503).json({ error: BILLING_UNCONFIGURED_MESSAGE });
    return true;
  }

  // Balance plus storage. The client also reads entitlements/{uid} live from Firestore;
  // this route exists so the storage figure gets recomputed from the bucket, which the
  // client has no way to do for itself.
  if (path === '/api/billing/account' && method === 'GET') {
    const [entitlement, storage] = await Promise.all([ensureEntitlement(uid), getStorageUsage(uid)]);
    response.status(200).json({
      tokenBalance: entitlement.tokenBalance,
      tokensGrantedLifetime: entitlement.tokensGrantedLifetime,
      tokensSpentLifetime: entitlement.tokensSpentLifetime,
      storage,
      packs: TOKEN_PACKS,
      actionPrices: ACTION_PRICES,
      paymentsEnabled: isStripeConfigured(),
    });
    return true;
  }

  if (path === '/api/billing/storage/check' && method === 'POST') {
    const additionalBytes = Number(request.body?.additionalBytes ?? 0);
    if (!Number.isFinite(additionalBytes) || additionalBytes < 0) {
      response.status(400).json({ error: 'additionalBytes must be a non-negative number.' });
      return true;
    }
    response.status(200).json(await checkStorageAllowance(uid, additionalBytes));
    return true;
  }

  if (path === '/api/billing/checkout' && method === 'POST') {
    if (!isStripeConfigured()) {
      response.status(503).json({ error: 'Payments are not configured on this deployment yet.' });
      return true;
    }
    try {
      const origin = request.headers?.origin || request.headers?.Origin || null;
      const session = await createCheckoutSession({
        packId: String(request.body?.packId || ''),
        uid,
        email: request.body?.email ?? null,
        origin: Array.isArray(origin) ? origin[0] : origin,
      });
      response.status(200).json(session);
    } catch (error: any) {
      response.status(400).json({ error: error?.message || 'Could not start checkout.' });
    }
    return true;
  }

  response.status(404).json({ error: 'Not found' });
  return true;
};
