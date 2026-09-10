// Stripe wiring. Server-only.
//
// Token packs are created as inline `price_data` rather than pre-made Price objects in the
// Stripe dashboard, so pricing.ts stays the single place a price is defined and the two can
// never disagree.
import { getTokenPack, type TokenPack } from './pricing';

let stripePromise: Promise<any> | null = null;

export const isStripeConfigured = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY);

export const getStripe = async (): Promise<any | null> => {
  if (!isStripeConfigured()) return null;
  stripePromise ||= (async () => {
    const { default: Stripe } = await import('stripe');
    // No apiVersion pin: the SDK version in package.json already fixes the behaviour, and
    // pinning a version far older than the SDK means its request and response shapes no
    // longer match what it was built for. The webhook endpoint carries its own API version,
    // set in the Stripe dashboard; stripeWebhook.ts only reads fields that are stable
    // across all of them.
    return new Stripe(process.env.STRIPE_SECRET_KEY as string);
  })();
  return stripePromise;
};

/** Where Stripe sends the buyer back. Falls back to the request's own origin. */
const resolveAppUrl = (requestOrigin?: string | null): string => {
  const configured = process.env.APP_BASE_URL || process.env.VITE_APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  if (requestOrigin) return requestOrigin.replace(/\/+$/, '');
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return vercelUrl ? `https://${vercelUrl}` : '';
};

export interface CheckoutSessionRequest {
  packId: string;
  uid: string;
  email: string | null;
  origin?: string | null;
}

export const createCheckoutSession = async (
  request: CheckoutSessionRequest,
): Promise<{ url: string; sessionId: string }> => {
  const stripe = await getStripe();
  if (!stripe) throw new Error('Payments are not configured on this deployment.');

  const pack: TokenPack | undefined = getTokenPack(request.packId);
  if (!pack) throw new Error(`Unknown token pack: ${request.packId}`);

  const appUrl = resolveAppUrl(request.origin);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    // The webhook credits the account, not the success redirect — a buyer who closes the
    // tab before being redirected must still get the tokens they paid for.
    success_url: `${appUrl}/?checkout=success&pack=${encodeURIComponent(pack.id)}`,
    cancel_url: `${appUrl}/?checkout=cancelled`,
    customer_email: request.email || undefined,
    client_reference_id: request.uid,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pack.priceCents,
          product_data: {
            name: `${pack.tokens.toLocaleString()} ArchAI tokens`,
            description: 'Tokens for floorplan generation, conversion and AI rendering.',
          },
        },
      },
    ],
    // Read back by the webhook. client_reference_id alone is not enough: we need to know
    // which pack was bought to know how many tokens to credit.
    metadata: {
      uid: request.uid,
      packId: pack.id,
      tokens: String(pack.tokens),
    },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  return { url: session.url, sessionId: session.id };
};
