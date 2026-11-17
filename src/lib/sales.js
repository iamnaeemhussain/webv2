// New-eSIM checkout and signed DPay durable inbox. Fulfilment runs only in scheduled.js.
import { ApiError, assertSameOrigin, json, nowIso, readJsonBody } from './http.js';
import { parseIdempotencyKey, parsePlanId, newOrderId } from './validate.js';
import { findPlan } from './plans.js';
import { createPaymentSession, dpayConfigured, verifyWebhookSignature } from './dpay.js';
import { rateLimit } from './ratelimit.js';
import { requireDb } from './orders.js';

// Expose only whether automatic checkout is ready, never the configuration values.
export function automaticCheckoutAvailable(env) {
  const present = value => typeof value === 'string' && value.trim().length > 0;
  const base = (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return env.PREVIEW_CATALOGUE !== 'true' && env.ENABLE_NEW_ESIM_SALES === 'true' &&
    dpayConfigured(env) && present(env.DPAY_WEBHOOK_SECRET) && present(env.YESIM_API_TOKEN) &&
    present(env.BREVO_API_KEY) && present(env.BREVO_SENDER_EMAIL) &&
    /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base);
}

export async function checkout(request, env, ctx, url) {
  assertSameOrigin(request);
  await rateLimit(env, ctx, request, 'new-checkout', 6);
  const db = requireDb(env);
  const key = parseIdempotencyKey(request.headers.get('idempotency-key'));
  const body = await readJsonBody(request);
  const planId = parsePlanId(body.planId);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
  if (!automaticCheckoutAvailable(env)) throw new ApiError(503, 'not_configured', 'Online eSIM orders are not available yet. Please contact support.');
  const base = (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base)) throw new ApiError(503,'not_configured','Checkout is not configured.');
  const prior = await db.prepare('SELECT * FROM new_esim_orders WHERE idempotency_key = ?1').bind(key).first();
  if (prior) {
    if (prior.plan_id !== planId || prior.email !== email) throw new ApiError(409, 'idempotency_conflict', 'Please start a new checkout.');
    if (prior.checkout_url && prior.payment_status === 'pending') return json({orderId: prior.id, checkoutUrl: prior.checkout_url, amountPkr: prior.amount_pkr});
    throw new ApiError(409, 'checkout_in_progress', 'This checkout cannot be resumed. Please contact support with your reference.');
  }
  const plan = await findPlan(env, planId, {fresh: true});
  if (!plan) throw new ApiError(404, 'plan_unavailable', 'That plan is no longer available.');
  if (Number(body.pricePkr) !== plan.pricePkr) throw new ApiError(409, 'price_changed', 'The plan price has changed. Please refresh and review it.');
  const order = newOrderId(), now = nowIso();
  const inserted = await db.prepare(`INSERT INTO new_esim_orders (id,idempotency_key,email,plan_id,plan_name,amount_pkr,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(idempotency_key) DO NOTHING`).bind(order,key,email,planId,plan.name,plan.pricePkr,now).run();
  if (!inserted.meta.changes) throw new ApiError(409,'checkout_in_progress','Your checkout is being prepared.');
  let session;
  try {
    session = await createPaymentSession(env, {orderId:order, amountPkr:plan.pricePkr, description:`Pak-Tel eSIM: ${plan.name}`, successUrl:`${base}/?order=${order}`, cancelUrl:`${base}/?order=${order}`, metadata:{order_id:order, order_type:'new_esim'}});
    const checkoutUrl = new URL(session.checkout_url);
    if (!/^[A-Za-z0-9_]{6,80}$/.test(session.id || '') || checkoutUrl.protocol !== 'https:' || session.order_id !== order || session.currency !== 'PKR' || typeof session.livemode !== 'boolean' || Number(session.amount) !== plan.pricePkr * 100) throw new Error('invalid session');
  } catch {
    // A session may have been created despite a timeout. Do not automatically create another.
    await db.prepare("UPDATE new_esim_orders SET payment_status='review',updated_at=?2 WHERE id=?1").bind(order,nowIso()).run();
    throw new ApiError(503,'checkout_review',`Checkout could not be confirmed. Contact support with reference ${order}.`);
  }
  await db.prepare('UPDATE new_esim_orders SET dpay_session_id=?2,checkout_url=?3,updated_at=?4,livemode=?5 WHERE id=?1').bind(order,session.id,session.checkout_url,nowIso(),session.livemode ? 1 : 0).run();
  return json({orderId:order,checkoutUrl:session.checkout_url,amountPkr:plan.pricePkr},201);
}

export async function webhook(request, env) {
  if (!env.DPAY_WEBHOOK_SECRET || !env.DB) return json({error:{code:'not_configured'}},503);
  // Bound both the declared and actual body before signature verification.
  if (Number(request.headers.get('content-length') || 0) > 100000) return json({error:{code:'too_large'}},413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 100000) return json({error:{code:'too_large'}},413);
  if (!await verifyWebhookSignature(raw,request.headers.get('dpay-signature'),env.DPAY_WEBHOOK_SECRET.trim())) return json({error:{code:'invalid_signature'}},400);
  let event; try { event = JSON.parse(raw); } catch { return json({error:{code:'invalid_json'}},400); }
  const id = event?.id, type = event?.type, session = event?.data?.object;
  const headerId = request.headers.get('dpay-event-id');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || typeof type !== 'string' || type.length > 60 || (headerId && headerId !== id)) return json({error:{code:'invalid_event'}},400);
  if (type === 'test.ping' || !['payment.succeeded','payment.failed','payment.expired','payment.ambiguous'].includes(type)) return json({received:true});
  if (typeof event.livemode !== 'boolean' || !session || typeof session.order_id !== 'string' || !/^PT-[A-Z0-9]{20}$/.test(session.order_id) || typeof session.id !== 'string' || !/^[A-Za-z0-9_]{6,80}$/.test(session.id)) return json({received:true,ignored:true});
  // Insert is the durable work item; no upstream calls and no ctx.waitUntil required for delivery.
  const insert = env.DB.prepare(`INSERT OR IGNORE INTO payment_inbox(event_id,type,order_id,session_id,session_status,amount,currency,livemode,received_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(id,type,session.order_id,session.id,typeof session.status === 'string' ? session.status.slice(0,40) : '',Number.isSafeInteger(session.amount) ? session.amount : null, typeof session.currency === 'string' ? session.currency.slice(0,10) : null, event.livemode === true ? 1 : 0, nowIso()).run();
  // Fail promptly when storage is unhealthy; never acknowledge work we could lose.
  let timer;
  try {
    await Promise.race([insert, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('storage timeout')), 7000); })]);
  } catch { return json({error:{code:'storage_unavailable'}},503); }
  finally { clearTimeout(timer); }
  return json({received:true});
}

export async function newOrderStatus(request, env, ctx, id) {
  await rateLimit(env,ctx,request,'new-order',60);
  if (!/^PT-[A-Z0-9]{20}$/.test(id)) throw new ApiError(404,'order_not_found','Order not found.');
  const row = await requireDb(env).prepare('SELECT id,plan_name,payment_status,fulfilment_status,email_status FROM new_esim_orders WHERE id=?1').bind(id).first();
  if (!row) throw new ApiError(404,'order_not_found','Order not found.');
  return json({order:{orderId:row.id,planName:row.plan_name,paymentStatus:row.payment_status,fulfilmentStatus:row.fulfilment_status,emailStatus:row.email_status}});
}
