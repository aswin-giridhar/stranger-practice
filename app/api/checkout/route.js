import { NextResponse } from 'next/server';
import { PLAN } from '@/lib/billing/plan';

export const runtime = 'nodejs';

const STRIPE_CHECKOUT_URL = 'https://api.stripe.com/v1/checkout/sessions';

function fail(status, code, message) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * POST /api/checkout
 *
 * request:  {}                       (no client-supplied price — the plan is server-side)
 * response: { url: String, mode: 'payment_link' | 'checkout_session', plan: String }
 *
 * Two configured paths, in order of preference:
 *   1. STRIPE_PAYMENT_LINK — a pre-made Stripe Payment Link. Zero API surface,
 *      nothing to get wrong, works the moment the link is pasted into Vercel.
 *   2. STRIPE_SECRET_KEY   — create a real Checkout Session over the REST API
 *      with plain fetch (no SDK dependency). Uses STRIPE_PRICE_ID when set,
 *      otherwise builds the line item inline from lib/billing/plan.js.
 *
 * With NEITHER set this returns 503 CONFIG_MISSING and the UI says payments
 * are not live yet. It must never return a 200 with no url, and never invent
 * a destination — a fake success on a payment path is the worst thing here.
 */
export async function POST(req) {
  const paymentLink = process.env.STRIPE_PAYMENT_LINK;
  if (paymentLink && paymentLink.trim()) {
    return NextResponse.json({
      url: paymentLink.trim(),
      mode: 'payment_link',
      plan: PLAN.id,
    });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || !secretKey.trim()) {
    return fail(
      503,
      'CONFIG_MISSING',
      'Payments are not live yet. Set STRIPE_PAYMENT_LINK or STRIPE_SECRET_KEY to enable checkout.',
    );
  }

  const origin = resolveOrigin(req);
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', `${origin}/?checkout=success`);
  params.set('cancel_url', `${origin}/?checkout=cancelled`);
  params.set('line_items[0][quantity]', '1');

  const priceId = process.env.STRIPE_PRICE_ID;
  if (priceId && priceId.trim()) {
    params.set('line_items[0][price]', priceId.trim());
  } else {
    params.set('line_items[0][price_data][currency]', PLAN.currency);
    params.set('line_items[0][price_data][unit_amount]', String(PLAN.unitAmount));
    params.set('line_items[0][price_data][recurring][interval]', PLAN.interval);
    params.set('line_items[0][price_data][product_data][name]', PLAN.productName);
    params.set('line_items[0][price_data][product_data][description]', PLAN.productDescription);
  }

  let res;
  let bodyText;
  try {
    res = await fetch(STRIPE_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey.trim()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    bodyText = await res.text();
  } catch (err) {
    return fail(502, 'UPSTREAM_ERROR', `Could not reach Stripe: ${err?.message || 'network error'}`);
  }

  if (!bodyText || !bodyText.trim()) {
    return fail(502, 'UPSTREAM_EMPTY', `Stripe returned an empty body (HTTP ${res.status}).`);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    // A 200 with an HTML error page is still a failure. Transport success is
    // not content validity.
    return fail(502, 'UPSTREAM_MALFORMED', 'Stripe returned a response that was not JSON.');
  }

  if (!res.ok) {
    const detail = data?.error?.message || `HTTP ${res.status}`;
    return fail(502, 'UPSTREAM_ERROR', `Stripe rejected the checkout session: ${detail}`);
  }

  if (typeof data?.url !== 'string' || !data.url) {
    return fail(
      502,
      'UPSTREAM_MALFORMED',
      'Stripe accepted the request but returned no checkout URL.',
    );
  }

  return NextResponse.json({ url: data.url, mode: 'checkout_session', plan: PLAN.id });
}

/**
 * Build the absolute origin for Stripe's return URLs. Vercel supplies the
 * deployment host in the forwarded headers; NEXT_PUBLIC_SITE_URL overrides it
 * when the canonical domain differs from the deployment one.
 */
function resolveOrigin(req) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');

  try {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    if (host) {
      const proto = req.headers.get('x-forwarded-proto') || 'https';
      return `${proto}://${host}`;
    }
    return new URL(req.url).origin;
  } catch {
    return 'https://stranger-practice.vercel.app';
  }
}
