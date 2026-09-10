import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI } from '@google/genai';
import { routeText2PlanApiRequest } from './text2planBackend';
import { routeText4dApiRequest } from './text4dBackend';
import { routeText4eApiRequest } from './text4eBackend';
import { routeText4fApiRequest } from './text4fBackend';
import { routeText4gApiRequest } from './text4gBackend';
import { routeText4hApiRequest } from './text4hBackend';
import { routeText4jApiRequest } from './text4jBackend';
import { routeSmartText2PlanApiRequest } from './smartText2planBackend';
import { routeAiRenderApiRequest } from './aiRender/backend';
import { routeAutoPlanApiRequest } from './autoPlan/backend/routes';
import { routeRevitExportApiRequest } from './revitExport/backend/revitExportApiRoutes';
import { ApsRevitExportBackend } from './revitExport/backend/apsRevitExportBackend';
import { createKvRevitExportJobStore } from './revitExport/backend/kvRevitExportJobStore';
import { routeApsRevitImportApiRequest } from './apsRevitImport/backend/apsRevitImportApiRoutes';
import { ApsRevitImportBackend } from './apsRevitImport/backend/apsRevitImportBackend';
import { createKvApsRevitImportJobStore } from './apsRevitImport/backend/kvApsRevitImportJobStore';
import { verifyApiRequestUser, isAnonymousApiAllowed, API_AUTH_REQUIRED_MESSAGE } from './firebase/adminAuth';
import { routeBillingApiRequest } from './billing/billingRoutes';
import { decideCharge, resolveRequestId, isPublicApiRoute } from './billing/routeCosts';
import {
  spendTokens,
  refundTokens,
  isBillingConfigured,
  isUnmeteredApiAllowed,
  BILLING_UNCONFIGURED_MESSAGE,
} from './billing/tokenLedger';
import { INSUFFICIENT_TOKENS_STATUS } from './billing/pricing';

// A single catch-all Vercel function serving every API route. Vercel's Hobby plan caps
// deployments at 12 serverless functions — one file per route family would have meant 13.
// This mirrors the exact dispatch logic already used by vite.config.js's dev middleware,
// just consolidated into one Lambda; none of the underlying route handlers changed.
//
// This file is the SOURCE of that function, not the deployed file. Vercel does not bundle
// functions in the api/ directory — it compiles them in place and traces their imports — and
// with package.json `"type": "module"` Node's ESM resolver refuses every extensionless
// relative specifier, which is what every import below (and every import inside services/)
// is. Deploying this file directly died with "Cannot find module
// '/var/task/services/text2planBackend'". So `npm run build:api` pre-bundles this module into
// a single self-contained api/index.js — the only file Vercel ever sees — leaving nothing but
// bare npm specifiers for the runtime to resolve. Edit this file, never api/index.js, and run
// `npm run build:api` (npm run build does it too) so the committed bundle stays in step.
type ApiRequestShape = {
  method?: string;
  url?: string;
  body?: any;
  userId?: string | null;
  headers?: Record<string, any>;
  /** Id of the token charge for this request, so async work can refund against it. */
  requestId?: string | null;
};

// vercel.json rewrites every /api/* request here as `/api?__path=/api/<original path>`,
// because a function in the api/ directory only serves its own path — nothing else matched
// /api/gemini/generateContent and Vercel answered with its own NOT_FOUND page. The rewrite
// makes req.url point at this file, so the original path travels in __path; rebuild the URL
// the route handlers expect (path + the caller's own query string) from it.
const resolveRequestUrl = (req: VercelRequest): string => {
  const [rawPath, rawQuery = ''] = (req.url || '').split('?');
  // Read __path (and the caller's own params) from both places Vercel may expose them:
  // the rewritten req.url's query string and the parsed req.query object.
  const search = new URLSearchParams(rawQuery);
  const query = (req.query || {}) as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || search.has(key)) continue;
    if (Array.isArray(value)) value.forEach(entry => search.append(key, entry));
    else search.append(key, value);
  }

  const forwarded = search.get('__path');
  search.delete('__path');
  const path = forwarded || rawPath;
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const dispatchGemini = async (req: VercelRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    return;
  }
  try {
    const { model, contents, config } = req.body || {};
    // Explicit vertexai: false — without it, the SDK falls back to
    // process.env.GOOGLE_GENAI_USE_VERTEXAI, which Vertex-backed flows sharing this
    // process (text4d-j, ai-render, auto-plan) set to 'true' as a side effect. Without
    // this override, this plain-API-key client silently gets hijacked into Vertex mode.
    const ai = new GoogleGenAI({ apiKey, vertexai: false });
    const result = await ai.models.generateContent({ model, contents, config });
    res.status(200).json({ text: result.text });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || String(error) });
  }
};

// Reused across warm invocations of this function, same as the dev middleware's singletons.
let revitExportBackend: ApsRevitExportBackend | undefined;
let apsRevitImportBackend: ApsRevitImportBackend | undefined;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = resolveRequestUrl(req);

  // Every route below spends the project's Gemini, Vertex or Autodesk quota, so none of
  // them is safe to serve anonymously. apiAuthInterceptor.ts attaches the caller's Firebase
  // ID token to every same-origin /api/* fetch; without a valid one the answer is 401.
  const user = await verifyApiRequestUser(req);
  if (!user && !isAnonymousApiAllowed() && !isPublicApiRoute(url, req.method)) {
    res.status(401).json({ error: API_AUTH_REQUIRED_MESSAGE });
    return;
  }

  const request: ApiRequestShape = {
    method: req.method,
    url,
    body: req.body,
    userId: user?.uid ?? null,
    headers: req.headers as Record<string, any>,
  };

  if (url.startsWith('/api/billing')) {
    await routeBillingApiRequest(request, res as any);
    return;
  }

  // Charge before the work happens, so a user cannot start ten generations at once on a
  // balance that only covers one. The debit is a Firestore transaction keyed by the
  // request id, so a retry of the same request re-uses the original charge.
  const requestId = resolveRequestId(req.headers as Record<string, any>);
  request.requestId = requestId;

  const decision = decideCharge({
    url,
    method: req.method,
    userId: user?.uid ?? null,
    billingConfigured: isBillingConfigured(),
    unmeteredAllowed: isUnmeteredApiAllowed(),
  });

  if (decision.kind === 'unconfigured') {
    res.status(503).json({ error: BILLING_UNCONFIGURED_MESSAGE });
    return;
  }

  let charged: { amount: number; reason: any; detail: string } | null = null;
  if (decision.kind === 'charge' && user) {
    try {
      const result = await spendTokens(user.uid, {
        amount: decision.charge.amount,
        reason: decision.charge.reason,
        requestId,
        detail: decision.charge.detail,
      });
      if (!result.ok) {
        res.status(INSUFFICIENT_TOKENS_STATUS).json({
          error: `You need ${decision.charge.amount} tokens for this and have ${result.balance}.`,
          required: decision.charge.amount,
          balance: result.balance,
          reason: decision.charge.reason,
        });
        return;
      }
      charged = decision.charge;
    } catch (error: any) {
      res.status(503).json({ error: error?.message || 'Could not check your token balance.' });
      return;
    }
  }

  // Watch the status the route ends up sending, so work that failed can be paid back.
  let finalStatus = 200;
  if (charged) {
    const originalStatus = res.status.bind(res);
    (res as any).status = (code: number) => {
      finalStatus = code;
      return originalStatus(code);
    };
  }

  const refundIfFailed = async () => {
    if (!charged || !user || finalStatus < 400) return;
    await refundTokens(user.uid, {
      amount: charged.amount,
      reason: charged.reason,
      requestId,
      detail: `${charged.detail} failed (${finalStatus}) — tokens returned.`,
    }).catch(err => console.error('Token refund failed:', err));
  };

  try {
    if (url.startsWith('/api/gemini/generateContent')) {
      await dispatchGemini(req, res);
      return;
    }

    if (url.startsWith('/api/text2plan')) {
      const handled = await routeText2PlanApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/text4d')) {
      const handled = await routeText4dApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/text4e')) {
      const handled = await routeText4eApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/text4f')) {
      const handled = await routeText4fApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/text4g')) {
      const handled = await routeText4gApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/text4h')) {
      const handled = await routeText4hApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/text4j')) {
      const handled = await routeText4jApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/smart-text2plan')) {
      const handled = await routeSmartText2PlanApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/ai-render')) {
      const handled = await routeAiRenderApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/auto-plan')) {
      const handled = await routeAutoPlanApiRequest(request, res as any);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/exports/revit')) {
      if (!revitExportBackend) {
        revitExportBackend = new ApsRevitExportBackend(undefined, createKvRevitExportJobStore());
      }
      const handled = await routeRevitExportApiRequest(request, res as any, revitExportBackend);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }
    if (url.startsWith('/api/imports/aps-revit')) {
      if (!apsRevitImportBackend) {
        apsRevitImportBackend = new ApsRevitImportBackend(undefined, createKvApsRevitImportJobStore());
      }
      const handled = await routeApsRevitImportApiRequest(request, res as any, apsRevitImportBackend);
      if (!handled) res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (error: any) {
    if (!res.writableEnded) {
      res.status(500).json({ error: error?.message || String(error) });
    }
  } finally {
    await refundIfFailed();
  }
}
