// Durable background processing. Never invoked by the webhook or the return URL.
import qrcode from 'qrcode-generator';
import { nowIso } from './http.js';
import { performTopup } from './topup.js';

const stale = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
async function processEvent(env, e) {
  const db = env.DB;
  const fresh = await db.prepare('SELECT * FROM new_esim_orders WHERE id=?1').bind(e.order_id).first();
  const topup = fresh ? null : await db.prepare('SELECT * FROM transactions WHERE id=?1').bind(e.order_id).first();
  const order = fresh || topup;
  // Checkout creation may be in flight, so do not consume the event prematurely.
  if (!order || !order.dpay_session_id) {
    if (e.received_at < stale()) await db.prepare("UPDATE payment_inbox SET state='review' WHERE event_id=?1 AND state='pending'").bind(e.event_id).run();
    return;
  }
  const table = fresh ? 'new_esim_orders' : 'transactions';
  const matches = e.session_id === order.dpay_session_id && e.amount === order.amount_pkr * 100 && (!e.currency || e.currency === 'PKR') && e.livemode === order.livemode;
  let status = null;
  if (!matches || (e.type === 'payment.succeeded' && e.session_status !== 'succeeded')) status = 'review';
  else if (e.type === 'payment.succeeded') status = 'paid';
  else if (e.type === 'payment.expired') status = 'expired';
  else if (e.type === 'payment.failed') status = 'failed';
  else if (e.type === 'payment.ambiguous') status = 'review';
  const update = db.prepare(fresh
    ? `UPDATE new_esim_orders SET payment_status=?2,updated_at=?3 WHERE id=?1 AND payment_status != 'paid'`
    : `UPDATE transactions SET payment_status=?2,updated_at=?3,paid_at=CASE WHEN ?2='paid' THEN COALESCE(paid_at,?3) ELSE paid_at END WHERE id=?1 AND payment_status != 'paid'`).bind(order.id,status,nowIso());
  const done = db.prepare("UPDATE payment_inbox SET state=?2 WHERE event_id=?1 AND state='pending'").bind(e.event_id,matches ? 'done' : 'review');
  // The durable event and payment transition commit together.
  await db.batch([update,done]);
}

async function issue(env, order) {
  const claim = await env.DB.prepare("UPDATE new_esim_orders SET fulfilment_status='issuing',updated_at=?2 WHERE id=?1 AND payment_status='paid' AND fulfilment_status='not_started'").bind(order.id,nowIso()).run();
  if (!claim.meta.changes) return;
  // GET /new_esim is a side effect. No retries: any uncertain outcome requires human review.
  try {
    const url = new URL((env.YESIM_API_BASE || 'https://partners-api.yesim.biz').replace(/\/+$/,'') + '/new_esim');
    url.searchParams.set('token',env.YESIM_API_TOKEN);
    url.searchParams.set('plan_id',order.plan_id);
    url.searchParams.set('payment_id',order.id);
    const response = await fetch(url.toString(),{headers:{accept:'application/json'},signal:AbortSignal.timeout(25000)});
    let data; try { data = await response.json(); } catch { data = null; }
    // An active_plan_id can be present before the plan's start timestamp; do not promise
    // that the validity period has started. The issued plan must match the purchased ID.
    if (!response.ok || !data || !/^\d{19,20}$/.test(String(data.iccid || '')) || !/^LPA:1\$[\x21-\x7e]{3,200}$/.test(data.qrcode || '') || String(data.active_plan_id || '') !== order.plan_id) throw new Error('review');
    await env.DB.prepare("UPDATE new_esim_orders SET iccid=?2,lpa=?3,fulfilment_status='issued',email_status='pending',updated_at=?4 WHERE id=?1 AND fulfilment_status='issuing'").bind(order.id,String(data.iccid),data.qrcode,nowIso()).run();
  } catch {
    // Never log the error: fetch errors can contain Yesim's token-bearing URL.
    await env.DB.prepare("UPDATE new_esim_orders SET fulfilment_status='review',updated_at=?2 WHERE id=?1 AND fulfilment_status='issuing'").bind(order.id,nowIso()).run();
  }
}

const escapeHtml = s => String(s).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function email(env, order) {
  const claim = await env.DB.prepare("UPDATE new_esim_orders SET email_status='sending',updated_at=?2 WHERE id=?1 AND fulfilment_status='issued' AND email_status='pending'").bind(order.id,nowIso()).run();
  if (!claim.meta.changes) return;
  try {
    if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) throw new Error('not configured');
    const qr = qrcode(0,'M'); qr.addData(order.lpa); qr.make();
    const gif = qr.createDataURL(6, 24).split(',')[1];
    const response = await fetch((env.BREVO_API_BASE || 'https://api.brevo.com/v3').replace(/\/+$/,'')+'/smtp/email', {
      method:'POST', headers:{'api-key':env.BREVO_API_KEY,'content-type':'application/json',accept:'application/json'}, signal:AbortSignal.timeout(20000),
      body:JSON.stringify({sender:{name:'Pak-Tel',email:env.BREVO_SENDER_EMAIL},to:[{email:order.email}],subject:'Your Pak-Tel eSIM',
        htmlContent:`<p>Thank you for your order ${escapeHtml(order.id)}.</p><p>Your ${escapeHtml(order.plan_name)} eSIM is ready. Scan the attached QR code in your device's eSIM settings.</p><p>ICCID: ${escapeHtml(order.iccid)}</p><p>Manual activation code: ${escapeHtml(order.lpa)}</p><p>Keep this message private. If you need help, contact help@pak-tel.com.</p>`,
        attachment:[{name:'pak-tel-esim-qr.gif',content:gif}]})
    });
    if (!response.ok) throw new Error('email rejected or uncertain');
    await env.DB.prepare("UPDATE new_esim_orders SET email_status='sent',updated_at=?2 WHERE id=?1 AND email_status='sending'").bind(order.id,nowIso()).run();
  } catch {
    // A timeout can mean the email was accepted; do not automatically send again.
    await env.DB.prepare("UPDATE new_esim_orders SET email_status='review',updated_at=?2 WHERE id=?1 AND email_status='sending'").bind(order.id,nowIso()).run();
  }
}
async function topup(env, order) {
  const claim = await env.DB.prepare("UPDATE transactions SET topup_status='processing',updated_at=?2 WHERE id=?1 AND payment_status='paid' AND topup_status='not_started'").bind(order.id,nowIso()).run();
  if (!claim.meta.changes) return;
  let result; try { result = await performTopup(env,order.iccid,order.plan_id); } catch { result = {status:'review',verified:false,error:'exception'}; }
  await env.DB.prepare("UPDATE transactions SET topup_status=?2,topup_verified=?3,topup_error=?4,topup_at=?5,updated_at=?5 WHERE id=?1 AND topup_status='processing'").bind(order.id,result.status,result.verified?1:0,result.error,nowIso()).run();
}
export async function runScheduled(env) {
  if (!env.DB) return;
  const db = env.DB;
  // Crashed workers may have completed the external operation. Escalate, never repeat it.
  await db.batch([
    db.prepare("UPDATE new_esim_orders SET fulfilment_status='review' WHERE fulfilment_status='issuing' AND updated_at < ?1").bind(stale()),
    db.prepare("UPDATE new_esim_orders SET email_status='review' WHERE email_status='sending' AND updated_at < ?1").bind(stale()),
    db.prepare("UPDATE transactions SET topup_status='review' WHERE topup_status='processing' AND updated_at < ?1").bind(stale())
  ]);
  const events = await db.prepare("SELECT * FROM payment_inbox WHERE state='pending' ORDER BY received_at LIMIT 50").all();
  for (const e of events.results) await processEvent(env,e);
  const fresh = await db.prepare("SELECT * FROM new_esim_orders WHERE payment_status='paid' AND fulfilment_status='not_started' ORDER BY created_at LIMIT 10").all();
  for (const order of fresh.results) await issue(env,order);
  const emails = await db.prepare("SELECT * FROM new_esim_orders WHERE fulfilment_status='issued' AND email_status='pending' ORDER BY created_at LIMIT 10").all();
  for (const order of emails.results) await email(env,order);
  const topups = await db.prepare("SELECT * FROM transactions WHERE payment_status='paid' AND topup_status='not_started' ORDER BY created_at LIMIT 10").all();
  for (const order of topups.results) await topup(env,order);
}
