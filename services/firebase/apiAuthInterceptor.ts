// Attaches the signed-in user's Firebase ID token to every same-origin /api/* request.
//
// The alternative was editing ~30 `fetch('/api/…')` call sites spread across services/ and
// components/, every one of which would then have to stay in step. A single fetch wrapper
// installed once at startup keeps the token concern in one file and leaves those call sites
// untouched. Requests to anything other than this origin's /api/* are passed straight
// through, so third-party fetches (Google Maps, Roboflow, Storage downloads) never see the
// token.
import { getFirebaseAuth, isFirebaseConfigured } from './firebaseConfig';

let installed = false;

/**
 * Raised when an /api/* call comes back 401 even after a token refresh — i.e. the user is
 * genuinely signed out. App.tsx listens and opens the existing AuthModal, so a signed-out
 * user pressing Generate gets a sign-in prompt instead of an opaque failure. Doing it here
 * rather than in each wizard keeps every generation call site untouched.
 */
export const API_AUTH_REQUIRED_EVENT = 'archai-api-auth-required';

/**
 * Raised when an /api/* call is refused for want of tokens (402). App.tsx listens and opens
 * the tokens panel, so running out mid-generation explains itself instead of surfacing as a
 * failed request. The event carries what the action needed and what the user has.
 */
export const TOKENS_REQUIRED_EVENT = 'archai-tokens-required';

/**
 * Charges are keyed by this header so a retry cannot be billed twice — see
 * services/billing/routeCosts.ts. A fresh id per call is what we want: two deliberate
 * generations are two charges; one generation retried after a network blip is one.
 */
const nextRequestId = (): string =>
  `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const isSameOriginApiRequest = (input: RequestInfo | URL): boolean => {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
};

// Reads the 402 body without consuming it for the caller — the calling code still gets a
// readable response and can render its own error.
const announceInsufficientTokens = async (response: Response): Promise<void> => {
  let detail: Record<string, unknown> = {};
  try {
    detail = await response.clone().json();
  } catch {
    // Body was not JSON; the event is still worth raising.
  }
  window.dispatchEvent(new CustomEvent(TOKENS_REQUIRED_EVENT, { detail }));
};

const getIdToken = async (forceRefresh: boolean): Promise<string | null> => {
  try {
    const user = getFirebaseAuth().currentUser;
    if (!user) return null;
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
};

/**
 * Idempotent — safe to call from a React effect that may run twice under StrictMode.
 * No-op when Firebase isn't configured on this deployment, which leaves the app behaving
 * exactly as it did before.
 */
export const installApiAuthInterceptor = (): void => {
  if (installed || typeof window === 'undefined' || !isFirebaseConfigured) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isSameOriginApiRequest(input)) return originalFetch(input, init);

    const requestId = nextRequestId();

    const send = async (token: string | null): Promise<Response> => {
      // A Request object carries its own headers, so merge into whichever the caller used.
      if (input instanceof Request && !init) {
        const request = new Request(input);
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
        request.headers.set('X-Request-Id', requestId);
        return originalFetch(request);
      }
      const headers = new Headers((init?.headers as HeadersInit | undefined) || (input instanceof Request ? input.headers : undefined));
      if (token) headers.set('Authorization', `Bearer ${token}`);
      headers.set('X-Request-Id', requestId);
      return originalFetch(input, { ...init, headers });
    };

    const response = await send(await getIdToken(false));

    // A cached token that expired while the tab sat idle looks exactly like being signed
    // out. Refresh once and retry before surfacing the 401 to the caller. Skipped for a
    // Request input, whose body the first attempt already consumed and cannot replay.
    if (response.status === 401 && !(input instanceof Request)) {
      const refreshed = await getIdToken(true);
      if (refreshed) {
        const retried = await send(refreshed);
        if (retried.status === 401) window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT));
        if (retried.status === 402) await announceInsufficientTokens(retried);
        return retried;
      }
    }
    if (response.status === 401) window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT));
    if (response.status === 402) await announceInsufficientTokens(response);
    return response;
  };
};
