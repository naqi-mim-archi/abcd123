import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleStripeWebhook } from './billing/stripeWebhook';

// Source of api/stripe-webhook.js — a second serverless function alongside the /api
// catch-all, built by scripts/buildApiFunction.mjs. It exists separately because Stripe
// signs the raw request bytes, so this route must receive the body unparsed; the config
// export below is what turns Vercel's JSON body parser off.
//
// Vercel checks the filesystem before applying vercel.json rewrites, so a real file at
// api/stripe-webhook.js wins over the `/api/(.*)` rewrite and never reaches the auth gate —
// which is what we want, since Stripe has no Firebase ID token to send.
export const config = { api: { bodyParser: false } };

const readRawBody = (req: VercelRequest): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    const result = await handleStripeWebhook(
      rawBody,
      Array.isArray(signature) ? signature[0] : signature,
    );
    res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error('Stripe webhook failed:', error);
    res.status(500).json({ error: error?.message || String(error) });
  }
}
