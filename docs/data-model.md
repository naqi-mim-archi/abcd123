# Data model

Everything the app stores per user. Three Firestore collections plus one Cloud Storage
prefix. Access is enforced by `firestore.rules` and `storage.rules` — not by the client.

## `users/{uid}`

Display metadata for the signed-in account. Written by `upsertUserProfile()` in
`services/firebase/authService.ts` on every sign-in and whenever the display name changes.

| Field | Type | Notes |
|---|---|---|
| `email` | string \| null | ≤ 320 chars |
| `displayName` | string \| null | ≤ 120 chars |
| `photoURL` | string \| null | ≤ 2048 chars |
| `lastSignInAt` | timestamp | `serverTimestamp()` |

The rules allow **only** these four keys. Anything else is rejected. This matters because
the document is fully client-writable: if a `plan` field lived here, a user could grant
themselves a paid tier from the browser console.

## `entitlements/{uid}` — the token ledger, server-owned

Read-only to its owner, writable by nobody through the client (`allow write: if false`; the
Admin SDK bypasses rules). Written only by `services/billing/tokenLedger.ts`. Because a
client can read but never write it, the header's balance is a live `onSnapshot` on this
document rather than a polling endpoint.

| Field | Type | Notes |
|---|---|---|
| `tokenBalance` | int | What the user can spend right now |
| `tokensGrantedLifetime` | int | Signup grant + every purchase, for support questions |
| `tokensSpentLifetime` | int | Net of refunds |
| `storageBytesUsed` | int | Cached; recomputed from the bucket by `/api/billing/account` |
| `storageQuotaBytes` | int | Defaults to 5 GB (`FREE_STORAGE_BYTES`) |
| `signupGrantedAt` | timestamp | When the 100-token grant was given |

### `entitlements/{uid}/ledger/{entryId}`

Append-only audit trail; owner-readable, client-unwritable. `type` is
`grant` / `spend` / `refund` / `purchase`, `amount` is negative for a charge, and
`balanceAfter` records the running total.

**The document id is the idempotency key**, which is the whole reason double-charging is
impossible: a charge is written at the request id from `X-Request-Id`, a refund at
`<requestId>:refund`, and a purchase at `stripe-<event id>`. A replayed request, a Vercel
function retry, or a Stripe webhook delivered twice all find an entry already there and do
nothing. Every balance change happens inside a Firestore transaction that does all of its
reads before any write.

## Tokens and pricing

`services/billing/pricing.ts` is the single source of truth and is imported by both the
browser and the server, so the price shown and the price charged cannot drift.

| Action | Tokens |
|---|---|
| Generate a floorplan from a description, then digitise it | 50 |
| Convert a floorplan you already have | 25 |
| One AI render | 50 |
| One Revit export or APS Revit import | 25 |
| 2D/3D canvas, editing, exports, the chat/brief conversation | free |

Those first two prices are collected in halves. A generation and a conversion are separate
server calls, and an upload only ever makes the second one, so
`services/billing/routeCosts.ts` charges 25 at `/api/*/image` and 25 at the conversion
endpoints (`roboflow/convert`, `master-geometry`, `image-redraw`). Generate-and-convert
comes to 50; a conversion on its own is 25. Nothing is declared by the client, so there is
nothing for it to misreport. `scripts/testTokenPricing.mjs` asserts that the routes each
real flow makes still add up to the advertised price.

Packs: 100 for $9.99, 500 for $25.99, 1000 for $49.99. New accounts are granted 100 tokens
the first time the server sees them — "first sight" rather than "at sign-up", so accounts
created before billing existed are not stranded at zero.

Charges happen **before** the work, so a user cannot start ten generations at once on a
balance that covers one. Tokens are returned automatically when the work does not happen: a
route that answers 4xx/5xx refunds in its `finally`, and an AI-render job that fails or is
cancelled minutes later refunds against the `chargeRequestId` stored on the job.

Running out answers **402**, which `apiAuthInterceptor.ts` turns into an event that opens the
tokens panel with the shortfall spelled out — the same pattern the 401 uses for sign-in.

### Payments

Stripe Checkout. `/api/billing/checkout` creates a session from `TOKEN_PACKS` using inline
`price_data`, so prices live in code rather than in the Stripe dashboard where they could
drift. **The webhook credits the account, not the success redirect** — someone who closes
the tab after paying still gets their tokens.

`api/stripe-webhook.js` is a second serverless function rather than a branch of the
catch-all, for two reasons: Stripe signs the raw request bytes so the body must arrive
unparsed, and Stripe has no Firebase ID token to get past the auth gate. Vercel checks the
filesystem before applying `vercel.json` rewrites, so that file wins over `/api/(.*)`. The
token count credited is read from our own pack table, never from the session metadata.

## `projects/{projectId}`

Written by `saveProject()` in `services/firebase/projectsService.ts`.

| Field | Type | Notes |
|---|---|---|
| `ownerId` | string | Firebase uid. **Immutable** — the rules reject an update that changes it |
| `name` | string | ≤ 200 chars |
| `mode` | string | `Project['mode']` |
| `elementsCount` | int | For the listing row, so a summary never loads the payload |
| `thumbnailUrl` | string? | Download URL of `thumbnail.jpg`; ≤ 2048 chars |
| `storageMode` | `'inline' \| 'storage'` | Which of the two fields below carries the project |
| `data` | string? | `storageMode: 'inline'` — the serialized project, ≤ 900 KB |
| `dataUrl` | string? | `storageMode: 'storage'` — download URL of `project.json` |
| `createdAt` / `updatedAt` | timestamp | `serverTimestamp()` |

A Firestore document caps out at 1 MB. `INLINE_SIZE_LIMIT_BYTES` (700 KB) is the threshold
at which `saveProject` switches to Cloud Storage instead, keeping only the pointer and the
listing fields in Firestore.

### Required composite index

`listProjects()` filters by owner and orders by recency, which Firestore cannot serve from
its single-field indexes:

- Collection: `projects`
- Fields: `ownerId` ascending, `updatedAt` descending

Create it under **Firebase Console → Firestore → Indexes**. Without it `listProjects()`
fails with a `failed-precondition` error containing a one-click creation link.

## Cloud Storage — `users/{uid}/projects/{projectId}/`

| Object | Written by | Size cap |
|---|---|---|
| `project.json` | `saveProject()` above the inline threshold | 20 MB, `application/json` |
| `thumbnail.jpg` | `saveProject()` via `renderProjectThumbnail()` | 2 MB, `image/*` |
| `images/{name}` | `uploadProjectImage()` | 25 MB, `image/*` |

Caps exist because this is a Blaze-plan bucket where every byte is billable. Deleting a
project (`deleteProject`) and deleting an account (`deleteAccount`) both sweep this prefix —
without that, deleted work would keep costing money indefinitely.

### The 5 GB quota

`saveProject()` asks `/api/billing/storage/check` before any upload and refuses the save if
it would go past the limit, rather than discovering it half-way through. Usage is
**recomputed by listing the user's prefix** with the Admin SDK, not accumulated from
client-reported deltas — a client that can report "I wrote −5 GB" is not a quota. Listing
one account's prefix is a single cheap call, and it self-heals if a write or delete is ever
missed.

Without admin credentials, metering reports `metered: false` and saves are allowed through:
blocking every save on a deployment that has not finished its setup would be worse than not
metering. The tokens panel says so rather than showing a misleading 0 B.

Storage beyond 5 GB has no price yet — the buy path is the one part of the billing work
still waiting on a decision.

## API authentication

Every `/api/*` route requires a Firebase ID token. `services/firebase/apiAuthInterceptor.ts`
attaches it in the browser; `services/firebase/adminAuth.ts` verifies it in
`services/vercelApiHandler.ts` and in `vite.config.js`'s dev middleware. Long-running jobs
(AI render, Revit export, APS Revit import) record an `ownerId` and reject reads from anyone
else.

The one exception is `GET /api/billing/pricing`, the published price list: static, free to
produce, and useful to a signed-out visitor. `isPublicApiRoute()` is the single place that
exemption is defined, shared by both dispatchers.

## Server environment

| Variable | Needed for |
|---|---|
| `FIREBASE_PROJECT_ID` | Verifying ID tokens. Required in production |
| `FIREBASE_ADMIN_SA_KEY_JSON` | **Required for billing.** The ledger lives in Firestore, and admin Firestore access needs real credentials — a project id alone verifies a token but cannot read a document. Also required for storage metering |
| `STRIPE_SECRET_KEY` | Creating Checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | Verifying webhook signatures. Point a Stripe endpoint at `https://<domain>/api/stripe-webhook` for `checkout.session.completed` |
| `APP_BASE_URL` | Where Stripe returns the buyer. Falls back to the request origin, then `VERCEL_URL` |
| `ALLOW_ANONYMOUS_API=1` | Dev only: browse a local `vite dev` without signing in |
| `ALLOW_UNMETERED_API=1` | Dev only: run the AI routes without charging tokens |

Without `FIREBASE_ADMIN_SA_KEY_JSON`, every chargeable route answers **503** rather than
handing out paid AI work for free. That is deliberate — see `decideCharge()`, which is the
one place the "should this cost tokens" question is answered for both the Vercel function
and vite's dev middleware, so the two cannot drift apart.

The `scripts/test*.mjs` harnesses call the service modules in-process rather than over HTTP,
so neither the auth gate nor metering affects them.
