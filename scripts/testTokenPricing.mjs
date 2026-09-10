// Guards the prices the product actually charges. The cost of an action is not written down
// anywhere as a single number — it emerges from which routes a flow happens to call — so this
// asserts that the routes a real flow makes still add up to the advertised price.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const buildModule = async entryPoint => {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return import(url);
};

const { resolveRouteCharge, resolveRequestId } = await buildModule('services/billing/routeCosts.ts');
const { ACTION_PRICES, TOKEN_PACKS, SIGNUP_GRANT_TOKENS, FREE_STORAGE_BYTES, getTokenPack } =
  await buildModule('services/billing/pricing.ts');

const costOf = (path, method = 'POST') => resolveRouteCharge(path, method)?.amount ?? 0;
const totalFor = calls => calls.reduce((sum, [path, method]) => sum + costOf(path, method), 0);

// --- The advertised price list -----------------------------------------------
assert.equal(ACTION_PRICES.generateAndConvert, 50, 'Generate + convert must cost 50.');
assert.equal(ACTION_PRICES.convertOnly, 25, 'Converting an existing floorplan must cost 25.');
assert.equal(ACTION_PRICES.render, 50, 'A render must cost 50.');
assert.equal(SIGNUP_GRANT_TOKENS, 100, 'New accounts get 100 tokens.');
assert.equal(FREE_STORAGE_BYTES, 5 * 1024 ** 3, 'Free storage is 5 GB.');

assert.deepEqual(
  TOKEN_PACKS.map(pack => [pack.tokens, pack.priceUsd]),
  [[100, 9.99], [500, 25.99], [1000, 49.99]],
  'Token packs must match the published price list.',
);
for (const pack of TOKEN_PACKS) {
  assert.equal(pack.priceCents, Math.round(pack.priceUsd * 100), `${pack.id}: cents must match dollars.`);
  assert.equal(getTokenPack(pack.id).tokens, pack.tokens);
}
assert.equal(getTokenPack('pack-nonexistent'), undefined, 'Unknown packs must not resolve.');

// --- What a real flow costs, route by route ----------------------------------
// Text 4.0 J, describing a plan in words: generate the image, then digitise it.
assert.equal(
  totalFor([['/api/text4j/image'], ['/api/text4j/roboflow/convert']]),
  ACTION_PRICES.generateAndConvert,
  'Text 4.0 J generate-and-convert must come to the advertised 50.',
);

// Text 4.0 H / G take the same shape through the master-geometry endpoint.
assert.equal(
  totalFor([['/api/text4h/image'], ['/api/text4h/master-geometry']]),
  ACTION_PRICES.generateAndConvert,
  'Text 4.0 H generate-and-convert must come to 50.',
);

// AutoPlan: its own image endpoint plus the shared conversion.
assert.equal(
  totalFor([['/api/auto-plan/image'], ['/api/text4j/roboflow/convert']]),
  ACTION_PRICES.generateAndConvert,
  'AutoPlan generate-and-convert must come to 50.',
);

// Uploading a floorplan that already exists skips the generation half.
assert.equal(
  totalFor([['/api/text4j/roboflow/convert']]),
  ACTION_PRICES.convertOnly,
  'Converting an existing floorplan must come to 25.',
);
assert.equal(
  totalFor([['/api/text4h/image-redraw']]),
  ACTION_PRICES.convertOnly,
  'AutoScan redraw must come to 25.',
);

assert.equal(costOf('/api/ai-render/jobs'), ACTION_PRICES.render, 'Starting a render costs 50.');
assert.equal(
  costOf('/api/ai-render/jobs/abc123/retry'),
  ACTION_PRICES.render,
  'Retrying a render re-runs the model, so it costs again.',
);

assert.equal(costOf('/api/exports/revit'), ACTION_PRICES.revitJob, 'A Revit export costs 25.');
assert.equal(costOf('/api/imports/aps-revit'), ACTION_PRICES.revitJob, 'A Revit import costs 25.');

// --- What must stay free -----------------------------------------------------
const freeRoutes = [
  ['/api/gemini/generateContent', 'POST'],   // the chat/brief conversation
  ['/api/ai-render/jobs/abc123', 'GET'],     // polling a job you already paid for
  ['/api/ai-render/jobs/abc123/result', 'GET'],
  ['/api/ai-render/jobs/abc123/cancel', 'POST'],
  ['/api/ai-render/jobs/abc123/rate', 'POST'],
  ['/api/ai-render/auth/warm', 'POST'],
  ['/api/auto-plan/status', 'GET'],
  ['/api/auto-plan/health', 'GET'],
  ['/api/exports/revit/engines', 'GET'],
  ['/api/exports/revit/job-123', 'GET'],
  ['/api/imports/aps-revit/engines', 'GET'],
  ['/api/billing/account', 'GET'],
  ['/api/billing/checkout', 'POST'],
  ['/api/text4j/image', 'GET'],              // never charge a GET
];
for (const [path, method] of freeRoutes) {
  assert.equal(costOf(path, method), 0, `${method} ${path} must be free.`);
}

// Query strings must not let a caller slip past the cost table.
assert.equal(
  costOf('/api/text4j/image?cacheBust=1'),
  25,
  'A query string must not make a chargeable route free.',
);
assert.equal(costOf('/api/text4j/image/'), 25, 'A trailing slash must not make a route free.');

// --- Request ids -------------------------------------------------------------
assert.equal(resolveRequestId({ 'x-request-id': 'req-abc12345' }), 'req-abc12345');
assert.notEqual(
  resolveRequestId({ 'x-request-id': 'nope; DROP' }),
  'nope; DROP',
  'A malformed request id must be replaced, not used as a document key.',
);
assert.notEqual(resolveRequestId({}), resolveRequestId({}), 'Absent ids must not collide.');

// Firestore reserves ids that both start and end with a double underscore. One of those
// would make the charge throw, so a caller could 503 themselves with a header they control.
for (const reserved of ['__abcdef__', '__aaaaaaaaaa__', '__x_y_z__']) {
  assert.notEqual(
    resolveRequestId({ 'x-request-id': reserved }),
    reserved,
    `A Firestore-reserved id (${reserved}) must be replaced, not used as a document key.`,
  );
}
// A double underscore that is not at both ends is fine and should be honoured.
assert.equal(resolveRequestId({ 'x-request-id': '__leading-only' }), '__leading-only');
assert.equal(resolveRequestId({ 'x-request-id': 'trailing-only__' }), 'trailing-only__');

console.log('Token pricing tests passed.');

// --- The charge decision, which both dispatchers share -----------------------
const { decideCharge } = await buildModule('services/billing/routeCosts.ts');

const decide = overrides =>
  decideCharge({
    url: '/api/text4j/image',
    method: 'POST',
    userId: 'user-1',
    billingConfigured: true,
    unmeteredAllowed: false,
    ...overrides,
  });

assert.equal(decide({}).kind, 'charge', 'A signed-in user on a configured deployment is charged.');
assert.equal(decide({}).charge.amount, 25);

// A deployment that forgot its service-account key must refuse paid work, not give it away.
assert.equal(
  decide({ billingConfigured: false }).kind,
  'unconfigured',
  'Missing billing credentials must fail closed.',
);

// The two deliberate ways past that.
assert.equal(decide({ unmeteredAllowed: true }).kind, 'unmetered');
assert.equal(decide({ unmeteredAllowed: true }).why, 'disabled');
assert.equal(
  decide({ userId: null, billingConfigured: false }).kind,
  'unmetered',
  'An anonymous caller (ALLOW_ANONYMOUS_API in local dev) has no account to bill.',
);
assert.equal(decide({ userId: null }).why, 'anonymous');

// A free route stays free no matter how billing is configured.
for (const overrides of [{}, { billingConfigured: false }, { userId: null }, { unmeteredAllowed: true }]) {
  assert.equal(
    decide({ url: '/api/gemini/generateContent', ...overrides }).kind,
    'free',
    'Free routes are free regardless of billing configuration.',
  );
}

console.log('Charge decision tests passed.');

// --- What is reachable without an account ------------------------------------
const { isPublicApiRoute } = await buildModule('services/billing/routeCosts.ts');

assert.equal(isPublicApiRoute('/api/billing/pricing', 'GET'), true, 'The price list is public.');
assert.equal(isPublicApiRoute('/api/billing/pricing?v=2', 'GET'), true, 'A query string does not change that.');

// Nothing else may be reachable signed out — least of all anything that spends money or
// reads another account's data.
const mustRequireAuth = [
  ['/api/billing/pricing', 'POST'],
  ['/api/billing/account', 'GET'],
  ['/api/billing/checkout', 'POST'],
  ['/api/billing/storage/check', 'POST'],
  ['/api/text4j/image', 'POST'],
  ['/api/ai-render/jobs', 'POST'],
  ['/api/gemini/generateContent', 'POST'],
  ['/api/exports/revit', 'POST'],
];
for (const [path, method] of mustRequireAuth) {
  assert.equal(isPublicApiRoute(path, method), false, `${method} ${path} must require an account.`);
}

console.log('Public route tests passed.');
