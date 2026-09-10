// Handles Stripe's `checkout.session.completed` callback and credits the tokens.
//
// This is deliberately NOT part of the /api catch-all:
//  - Stripe signs the exact bytes of the request body, so the body must arrive unparsed.
//    Vercel parses JSON by default, and a re-serialised object will not match the signature.
//  - Stripe does not send a Firebase ID token, so it cannot pass the auth gate.
// api/stripe-webhook.ts is its own function with bodyParser disabled for those reasons.
//
// Crediting happens here rather than on the success redirect because a buyer who closes the
// tab before being redirected has still paid and must still get their tokens.
import { getStripe } from './stripeClient';
import { creditTokens } from './tokenLedger';
import { getTokenPack } from './pricing';

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export const handleStripeWebhook = async (
  rawBody: Buffer | string,
  signature: string | undefined,
): Promise<WebhookResult> => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return { status: 503, body: { error: 'STRIPE_WEBHOOK_SECRET is not configured.' } };
  }
  if (!signature) {
    return { status: 400, body: { error: 'Missing stripe-signature header.' } };
  }

  const stripe = await getStripe();
  if (!stripe) {
    return { status: 503, body: { error: 'STRIPE_SECRET_KEY is not configured.' } };
  }

  let event: any;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error: any) {
    // An unverifiable signature means this did not come from Stripe. Never act on it.
    return { status: 400, body: { error: `Signature verification failed: ${error?.message}` } };
  }

  if (event.type !== 'checkout.session.completed') {
    return { status: 200, body: { received: true, ignored: event.type } };
  }

  const session = event.data.object;
  if (session.payment_status !== 'paid') {
    return { status: 200, body: { received: true, ignored: 'unpaid session' } };
  }

  const uid = session.metadata?.uid || session.client_reference_id;
  const packId = session.metadata?.packId;
  if (!uid || !packId) {
    console.error('Stripe session without uid/packId metadata:', session.id);
    return { status: 200, body: { received: true, ignored: 'missing metadata' } };
  }

  // Read the token count from our own pack table, never from the session metadata — that
  // is the only copy an attacker replaying a session could not have influenced.
  const pack = getTokenPack(packId);
  if (!pack) {
    console.error('Stripe session for unknown pack:', packId);
    return { status: 200, body: { received: true, ignored: 'unknown pack' } };
  }

  // Keyed by the Stripe event id: Stripe retries deliveries, and a retry must not credit
  // the account a second time.
  const balance = await creditTokens(uid, {
    amount: pack.tokens,
    requestId: `stripe-${event.id}`,
    detail: `Purchased ${pack.tokens.toLocaleString()} tokens ($${pack.priceUsd})`,
  });

  return { status: 200, body: { received: true, credited: pack.tokens, balance } };
};
