import { defineConfig, loadEnv } from 'vite';
import { GoogleGenAI } from '@google/genai';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // Dev-only convenience: the server-side backend modules below (loaded via
  // ssrLoadModule) read secrets from process.env, but Vite's loadEnv() only returns
  // them into this local `env` object — it doesn't populate process.env itself. Mirror
  // everything from .env/.env.local into process.env so those modules can see it.
  for (const [key, value] of Object.entries(env)) {
    if (value && !process.env[key]) process.env[key] = value;
  }
  const buildTimestamp = new Date().toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  });
  let revitExportBackend = null;
  let apsRevitImportBackend = null;

  const readJsonBody = (request) => new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

  return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        warmup: {
          clientFiles: [
            './index.html',
            './App.tsx',
            './components/generative-wizard/GenerativeWizardCore.tsx',
          ],
        },
      },
    plugins: [{
      name: 'archai-revit-export-dev-api',
      configureServer(server) {
        let text2PlanBackendModulePromise;
        const loadText2PlanBackend = () => {
          text2PlanBackendModulePromise ||= server.ssrLoadModule('/services/text2planBackend.ts');
          return text2PlanBackendModulePromise;
        };
        let text4dBackendModulePromise;
        const loadText4dBackend = () => {
          text4dBackendModulePromise ||= server.ssrLoadModule('/services/text4dBackend.ts');
          return text4dBackendModulePromise;
        };
        let text4eBackendModulePromise;
        const loadText4eBackend = () => {
          text4eBackendModulePromise ||= server.ssrLoadModule('/services/text4eBackend.ts');
          return text4eBackendModulePromise;
        };
        let text4fBackendModulePromise;
        const loadText4fBackend = () => {
          text4fBackendModulePromise ||= server.ssrLoadModule('/services/text4fBackend.ts');
          return text4fBackendModulePromise;
        };
        let text4gBackendModulePromise;
        const loadText4gBackend = () => {
          text4gBackendModulePromise ||= server.ssrLoadModule('/services/text4gBackend.ts');
          return text4gBackendModulePromise;
        };
        let text4hBackendModulePromise;
        const loadText4hBackend = () => {
          text4hBackendModulePromise ||= server.ssrLoadModule('/services/text4hBackend.ts');
          return text4hBackendModulePromise;
        };
        let text4jBackendModulePromise;
        const loadText4jBackend = () => {
          text4jBackendModulePromise ||= server.ssrLoadModule('/services/text4jBackend.ts');
          return text4jBackendModulePromise;
        };
        let aiRenderBackendModulePromise;
        const loadAiRenderBackend = () => {
          aiRenderBackendModulePromise ||= server.ssrLoadModule('/services/aiRender/backend.ts');
          return aiRenderBackendModulePromise;
        };

        server.watcher.on('change', file => {
          const normalizedFile = file.replaceAll('\\', '/');
          if (normalizedFile.includes('/services/text2planBackend.ts') || normalizedFile.includes('/services/text4c')) {
            text2PlanBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/text4dBackend.ts') || normalizedFile.includes('/services/text4d')) {
            text4dBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/text4eBackend.ts') || normalizedFile.includes('/services/text4e')) {
            text4eBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/text4fBackend.ts') || normalizedFile.includes('/services/text4f')) {
            text4fBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/text4gBackend.ts') || normalizedFile.includes('/services/text4g')) {
            text4gBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/text4hBackend.ts') || normalizedFile.includes('/services/text4h')) {
            text4hBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/text4jBackend.ts') || normalizedFile.includes('/services/text4j')) {
            text4jBackendModulePromise = undefined;
          }
          if (normalizedFile.includes('/services/aiRender')) {
            aiRenderBackendModulePromise = undefined;
          }
        });

        server.httpServer?.once('listening', () => {
          // On-demand lazy loading: Backend modules load instantly when an API request is made
        });
        server.middlewares.use(async (request, response, next) => {
          // In production this is its own serverless function (api/stripe-webhook.js), which
          // vite knows nothing about — so without this branch a local `stripe listen` would
          // forward to the SPA, get a 200 back with index.html, and report every delivery as
          // delivered while nothing was ever credited. Handled first and separately because
          // it must skip the auth gate (Stripe has no Firebase token) and needs the raw
          // request bytes, which Stripe signs.
          if (request.url?.startsWith('/api/stripe-webhook')) {
            if (request.method !== 'POST') {
              response.statusCode = 405;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            try {
              const rawBody = await new Promise((resolve, reject) => {
                const chunks = [];
                request.on('data', chunk => chunks.push(Buffer.from(chunk)));
                request.on('end', () => resolve(Buffer.concat(chunks)));
                request.on('error', reject);
              });
              const { handleStripeWebhook } = await server.ssrLoadModule('/services/billing/stripeWebhook.ts');
              const result = await handleStripeWebhook(rawBody, request.headers['stripe-signature']);
              response.statusCode = result.status;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify(result.body));
            } catch (error) {
              response.statusCode = 500;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
            return;
          }

          const isRevitExportRequest = request.url?.startsWith('/api/exports/revit');
          const isApsRevitImportRequest = request.url?.startsWith('/api/imports/aps-revit');
          const isAutoPlanRequest = request.url?.startsWith('/api/auto-plan');
          const isText2PlanRequest = request.url?.startsWith('/api/text2plan');
          const isText4dRequest = request.url?.startsWith('/api/text4d');
          const isText4eRequest = request.url?.startsWith('/api/text4e');
          const isText4fRequest = request.url?.startsWith('/api/text4f');
          const isText4gRequest = request.url?.startsWith('/api/text4g');
          const isText4hRequest = request.url?.startsWith('/api/text4h');
          const isText4jRequest = request.url?.startsWith('/api/text4j');
          const isSmartText2PlanRequest = request.url?.startsWith('/api/smart-text2plan');
          const isAiRenderRequest = request.url?.startsWith('/api/ai-render');
          const isGeminiProxyRequest = request.url?.startsWith('/api/gemini/generateContent');
          const isBillingRequest = request.url?.startsWith('/api/billing');
          if (!isRevitExportRequest && !isApsRevitImportRequest && !isAutoPlanRequest && !isText2PlanRequest && !isText4dRequest && !isText4eRequest && !isText4fRequest && !isText4gRequest && !isText4hRequest && !isText4jRequest && !isSmartText2PlanRequest && !isAiRenderRequest && !isGeminiProxyRequest && !isBillingRequest) {
            next();
            return;
          }

          // Declared out here because the `finally` at the bottom needs them to decide
          // whether a charge has to be paid back.
          let apiUserId = null;
          let finalStatus = 200;
          let charged = null;
          let ledger = null;
          let requestId = null;

          try {
            // Same gate the deployed function applies (services/vercelApiHandler.ts): every
            // route below spends real Gemini/Vertex/APS quota. Set ALLOW_ANONYMOUS_API=1 to
            // browse locally without signing in — production must never set it.
            const { verifyApiRequestUser, isAnonymousApiAllowed, API_AUTH_REQUIRED_MESSAGE } =
              await server.ssrLoadModule('/services/firebase/adminAuth.ts');
            const { isPublicApiRoute } = await server.ssrLoadModule('/services/billing/routeCosts.ts');
            const apiUser = await verifyApiRequestUser(request);
            if (!apiUser && !isAnonymousApiAllowed() && !isPublicApiRoute(request.url, request.method)) {
              response.statusCode = 401;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({ error: API_AUTH_REQUIRED_MESSAGE }));
              return;
            }
            apiUserId = apiUser?.uid ?? null;

            const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
            const apiResponse = {
              status(code) {
                finalStatus = code;
                response.statusCode = code;
                return apiResponse;
              },
              json(payload) {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(payload));
              },
            };

            if (isBillingRequest) {
              const { routeBillingApiRequest } = await server.ssrLoadModule('/services/billing/billingRoutes.ts');
              await routeBillingApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                headers: request.headers,
                body,
              }, apiResponse);
              return;
            }

            // Same metering the deployed function applies, via the same decision function
            // so the two cannot drift. See services/billing/routeCosts.ts.
            const { decideCharge, resolveRequestId } = await server.ssrLoadModule('/services/billing/routeCosts.ts');
            ledger = await server.ssrLoadModule('/services/billing/tokenLedger.ts');
            const { INSUFFICIENT_TOKENS_STATUS } = await server.ssrLoadModule('/services/billing/pricing.ts');
            requestId = resolveRequestId(request.headers);

            const decision = decideCharge({
              url: request.url,
              method: request.method,
              userId: apiUserId,
              billingConfigured: ledger.isBillingConfigured(),
              unmeteredAllowed: ledger.isUnmeteredApiAllowed(),
            });

            if (decision.kind === 'unconfigured') {
              apiResponse.status(503).json({ error: ledger.BILLING_UNCONFIGURED_MESSAGE });
              return;
            }

            if (decision.kind === 'charge') {
              const spend = await ledger.spendTokens(apiUserId, {
                amount: decision.charge.amount,
                reason: decision.charge.reason,
                requestId,
                detail: decision.charge.detail,
              });
              if (!spend.ok) {
                apiResponse.status(INSUFFICIENT_TOKENS_STATUS).json({
                  error: `You need ${decision.charge.amount} tokens for this and have ${spend.balance}.`,
                  required: decision.charge.amount,
                  balance: spend.balance,
                  reason: decision.charge.reason,
                });
                return;
              }
              charged = decision.charge;
            }

            let handled = false;
            if (isRevitExportRequest) {
              const [{ routeRevitExportApiRequest }, { ApsRevitExportBackend }] = await Promise.all([
                server.ssrLoadModule('/services/revitExport/backend/revitExportApiRoutes.ts'),
                server.ssrLoadModule('/services/revitExport/backend/apsRevitExportBackend.ts'),
              ]);
              revitExportBackend ||= new ApsRevitExportBackend();
              handled = await routeRevitExportApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse, revitExportBackend);
            } else if (isApsRevitImportRequest) {
              const [{ routeApsRevitImportApiRequest }, { ApsRevitImportBackend }] = await Promise.all([
                server.ssrLoadModule('/services/apsRevitImport/backend/apsRevitImportApiRoutes.ts'),
                server.ssrLoadModule('/services/apsRevitImport/backend/apsRevitImportBackend.ts'),
              ]);
              apsRevitImportBackend ||= new ApsRevitImportBackend();
              handled = await routeApsRevitImportApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse, apsRevitImportBackend);
            } else if (isAutoPlanRequest) {
              const { routeAutoPlanApiRequest } = await server.ssrLoadModule('/services/autoPlan/backend/routes.ts');
              handled = await routeAutoPlanApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isSmartText2PlanRequest) {
              const { routeSmartText2PlanApiRequest } = await server.ssrLoadModule('/services/smartText2planBackend.ts');
              handled = await routeSmartText2PlanApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText4jRequest) {
              const { routeText4jApiRequest } = await loadText4jBackend();
              handled = await routeText4jApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText4hRequest) {
              const { routeText4hApiRequest } = await loadText4hBackend();
              handled = await routeText4hApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText4gRequest) {
              const { routeText4gApiRequest } = await loadText4gBackend();
              handled = await routeText4gApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText4fRequest) {
              const { routeText4fApiRequest } = await loadText4fBackend();
              handled = await routeText4fApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText4eRequest) {
              const { routeText4eApiRequest } = await loadText4eBackend();
              handled = await routeText4eApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText4dRequest) {
              const { routeText4dApiRequest } = await loadText4dBackend();
              handled = await routeText4dApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isText2PlanRequest) {
              const { routeText2PlanApiRequest } = await loadText2PlanBackend();
              handled = await routeText2PlanApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isAiRenderRequest) {
              const { routeAiRenderApiRequest } = await loadAiRenderBackend();
              handled = await routeAiRenderApiRequest({
                method: request.method,
                url: request.url,
                userId: apiUserId,
                requestId,
                body,
              }, apiResponse);
            } else if (isGeminiProxyRequest) {
              const apiKey = process.env.GEMINI_API_KEY || '';
              if (!apiKey) {
                apiResponse.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
              } else {
                const { model, contents, config } = body || {};
                // Explicit vertexai: false — see api/[...catchall].ts for why this matters.
                const ai = new GoogleGenAI({ apiKey, vertexai: false });
                const result = await ai.models.generateContent({ model, contents, config });
                apiResponse.json({ text: result.text });
              }
              handled = true;
            }
            if (!handled && !response.writableEnded) next();
          } catch (error) {
            if (!response.writableEnded) {
              response.statusCode = 500;
              finalStatus = 500;
              response.setHeader('Content-Type', 'application/json');
              response.end(JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          } finally {
            // Nobody pays for work that errored out.
            if (charged && apiUserId && finalStatus >= 400) {
              await ledger.refundTokens(apiUserId, {
                amount: charged.amount,
                reason: charged.reason,
                requestId,
                detail: `${charged.detail} failed (${finalStatus}) — tokens returned.`,
              }).catch(err => console.error('Token refund failed:', err));
            }
          }
        });
      },
    }],
    define: {
      'import.meta.env.VITE_BUILD_TIMESTAMP': JSON.stringify(buildTimestamp),
    },
  };
});
