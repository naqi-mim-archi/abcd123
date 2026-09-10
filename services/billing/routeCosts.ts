// Maps an API route to what it costs, which is where the advertised prices are actually
// enforced. See pricing.ts for why a generation and a conversion are charged separately:
// together they come to 50 for "generate and convert", and the conversion alone is the 25
// for "convert a floorplan I already have".
//
// Anything not listed here is free — the chat/brief conversation, job polling, engine
// listings, health checks and the whole 2D/3D canvas.
import { STEP_COSTS, type SpendReason } from './pricing';

export interface RouteCharge {
  amount: number;
  reason: SpendReason;
  /** Human-readable, stored on the ledger entry so a user can see what they paid for. */
  detail: string;
}

const stripQuery = (url: string): string => url.split('?')[0].replace(/\/+$/, '') || '/';

// Every text-generation family exposes the same two endpoints. `/image` renders the
// floorplan picture with the AI model; the geometry endpoints turn a picture into CAD data.
const GENERATION_PATTERNS: RegExp[] = [
  /^\/api\/text2plan\/image$/,
  /^\/api\/smart-text2plan\/image$/,
  /^\/api\/text4[a-j]\/image$/,
  /^\/api\/auto-plan\/image$/,
];

const CONVERSION_PATTERNS: RegExp[] = [
  /^\/api\/text4[a-j]\/master-geometry$/,
  /^\/api\/text4[a-j]\/image-redraw$/,
  /^\/api\/text4[a-j]\/roboflow\/convert$/,
  /^\/api\/text4[a-j]\/structured3d\/convert$/,
];

/**
 * What this request costs, or null when it is free.
 *
 * Only POSTs are ever charged: every GET here reads status, engines or results that the
 * caller has already paid for, and polling a job must never cost anything.
 */
export const resolveRouteCharge = (url: string, method: string | undefined): RouteCharge | null => {
  if (String(method || 'GET').toUpperCase() !== 'POST') return null;
  const path = stripQuery(url);

  if (GENERATION_PATTERNS.some(pattern => pattern.test(path))) {
    return {
      amount: STEP_COSTS.floorplanGeneration,
      reason: 'floorplan-generation',
      detail: 'Floorplan generation',
    };
  }

  if (CONVERSION_PATTERNS.some(pattern => pattern.test(path))) {
    return {
      amount: STEP_COSTS.floorplanConversion,
      reason: 'floorplan-conversion',
      detail: 'Floorplan conversion',
    };
  }

  // Creating a render job, and re-running one. Cancel, rate and status stay free.
  if (path === '/api/ai-render/jobs' || /^\/api\/ai-render\/jobs\/[^/]+\/retry$/.test(path)) {
    return { amount: STEP_COSTS.aiRender, reason: 'ai-render', detail: 'AI render' };
  }

  // Starting a Revit export or an APS Revit import. Both burn Autodesk credits per job.
  if (path === '/api/exports/revit') {
    return { amount: STEP_COSTS.revitJob, reason: 'revit-job', detail: 'Revit export' };
  }
  if (path === '/api/imports/aps-revit') {
    return { amount: STEP_COSTS.revitJob, reason: 'revit-job', detail: 'Revit import' };
  }

  return null;
};

/**
 * Charges are keyed by this so a retried or replayed request cannot be billed twice.
 * The client sends `X-Request-Id` (see apiAuthInterceptor.ts); when it is missing — a
 * direct API call, say — we fall back to a fresh id, which just means no replay protection
 * for that caller rather than a failed request.
 */
export const resolveRequestId = (headers: Record<string, any> | undefined): string => {
  const raw = headers?.['x-request-id'] || headers?.['X-Request-Id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && isUsableRequestId(value.trim())) return value.trim();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * The request id becomes a Firestore document id, so it has to be one Firestore will accept.
 * Beyond the character set, Firestore reserves any id that both starts and ends with a double
 * underscore — passing one through would make the charge throw and the caller get a 503
 * instead of their generation, for a header they control.
 */
const isUsableRequestId = (value: string): boolean =>
  /^[A-Za-z0-9_-]{8,120}$/.test(value) && !/^__.*__$/.test(value);

export type ChargeDecision =
  | { kind: 'free' }
  | { kind: 'unmetered'; why: 'anonymous' | 'disabled' }
  | { kind: 'unconfigured' }
  | { kind: 'charge'; charge: RouteCharge };

/**
 * The whole "should this cost tokens" decision in one place, so the Vercel function and
 * vite's dev middleware cannot drift apart on it. Pure, and therefore testable.
 *
 * `unconfigured` fails closed on purpose: a deployment that forgot its service-account key
 * must refuse paid AI work rather than hand it out for free. The two ways past that are
 * deliberate — ALLOW_UNMETERED_API, or ALLOW_ANONYMOUS_API, which implies no metering
 * because an anonymous caller has no account to bill.
 */
export const decideCharge = (options: {
  url: string;
  method?: string;
  userId: string | null;
  billingConfigured: boolean;
  unmeteredAllowed: boolean;
}): ChargeDecision => {
  const charge = resolveRouteCharge(options.url, options.method);
  if (!charge) return { kind: 'free' };
  if (options.unmeteredAllowed) return { kind: 'unmetered', why: 'disabled' };
  if (!options.userId) return { kind: 'unmetered', why: 'anonymous' };
  if (!options.billingConfigured) return { kind: 'unconfigured' };
  return { kind: 'charge', charge };
};

/**
 * The only route that serves callers without an account: the published price list. It is
 * static, costs nothing to produce, and a signed-out visitor being able to see what things
 * cost is the point of a price list. Everything else behind /api needs a signed-in caller.
 */
export const isPublicApiRoute = (url: string, method: string | undefined): boolean =>
  String(method || 'GET').toUpperCase() === 'GET' && stripQuery(url) === '/api/billing/pricing';
