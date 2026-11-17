import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createMock,TEST_YESIM_TOKEN,TEST_DPAY_KEY,TEST_WEBHOOK_SECRET} from './mock-upstream.mjs';
const mock = createMock(), mockPort = 18791, port = 18797;
await new Promise(r=>mock.server.listen(mockPort,'127.0.0.1',r));
const temp=mkdtempSync(path.join(tmpdir(),'pak-test-'));
const vars={YESIM_API_TOKEN:TEST_YESIM_TOKEN,DPAY_API_KEY:TEST_DPAY_KEY,DPAY_WEBHOOK_SECRET:TEST_WEBHOOK_SECRET,BREVO_API_KEY:'test-brevo-key',BREVO_SENDER_EMAIL:'sender@example.com',ENABLE_NEW_ESIM_SALES:'true',YESIM_API_BASE:`http://127.0.0.1:${mockPort}/yesim`,DPAY_API_BASE_URL:`http://127.0.0.1:${mockPort}/dpay`,BREVO_API_BASE:`http://127.0.0.1:${mockPort}/brevo`,PLANS_SHEET_CSV_URL:`http://127.0.0.1:${mockPort}/sheet.csv`,PUBLIC_BASE_URL:'https://pak.example'};
const args=['dev','--ip','127.0.0.1','--port',String(port),'--inspector-port','19412','--persist-to',temp,'--test-scheduled','--show-interactive-dev-session=false'];
for(const [k,v] of Object.entries(vars)) args.push('--var',`${k}:${v}`);
const child=spawn('./node_modules/.bin/wrangler',args,{stdio:'ignore',detached:true});
const base=`http://127.0.0.1:${port}`;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function call(path,opts={}) { const r=await fetch(base+path,{signal:AbortSignal.timeout(3000),...opts}); const t=await r.text(); let body; try{body=JSON.parse(t);}catch{body=t;} return {status:r.status,body}; }
async function eventually(fn) { for(let i=0;i<100;i++){const v=await fn(); if(v)return v; await wait(100);} throw new Error('timed out'); }
let testIp=1;
const post=(path,body,headers={})=>call(path,{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':`10.0.0.${testIp++}`,...headers},body:JSON.stringify(body)});
const create=()=>post('/api/new-esim/checkout',{planId:mock.PLAN_A,pricePkr:220,email:'buyer@example.com'},{'idempotency-key':crypto.randomUUID()});
const deliver=e=>call('/api/webhooks/dpay',{method:'POST',headers:e.headers,body:e.body});
const tick=()=>call('/__scheduled');
const order=async id=>(await call(`/api/new-esim/orders/${id}`)).body.order;
try {
 await eventually(async()=>{try{return (await call('/api/health')).status===200;}catch{return false;}});
 assert.match((await call('/')).body,/Pick a plan/);
 assert.match((await call('/manage/')).body,/my Pak-Tel/);
 const catalogue=await call('/api/plans');
 assert.equal(catalogue.body.plans[0].pricePkr,220);
 assert.equal(catalogue.body.autoCheckoutAvailable,true);
 const bad=await post('/api/new-esim/checkout',{planId:mock.PLAN_A,pricePkr:1,email:'buyer@example.com'},{'idempotency-key':crypto.randomUUID()}); assert.equal(bad.status,409);
 // Every checkout must re-read column B, even after a catalogue was cached for display.
 const beforeDpay=mock.state.dpayCalls;
 mock.state.sheetPrice=250;
 const changed=await post('/api/new-esim/checkout',{planId:mock.PLAN_A,pricePkr:220,email:'buyer@example.com'},{'idempotency-key':crypto.randomUUID()});
 assert.equal(changed.status,409); assert.equal(changed.body.error.code,'price_changed'); assert.equal(mock.state.dpayCalls,beforeDpay);
 mock.state.sheetPrice=220; mock.state.sheetBroken=true;
 const unavailable=await create();
 assert.equal(unavailable.status,502); assert.equal(mock.state.dpayCalls,beforeDpay);
 mock.state.sheetBroken=false;
 const key=crypto.randomUUID(), payload={planId:mock.PLAN_A,pricePkr:220,email:'buyer@example.com'};
 const c=await post('/api/new-esim/checkout',payload,{'idempotency-key':key}); assert.equal(c.status,201);
 const c2=await post('/api/new-esim/checkout',payload,{'idempotency-key':key}); assert.equal(c2.body.orderId,c.body.orderId);
 const session=[...mock.state.sessions.values()].find(s=>s.order_id===c.body.orderId);
 assert.equal(session.amount,22000); assert.equal(session.success_url,`https://pak.example/?order=${c.body.orderId}`);
 // A forged webhook and a success redirect cannot create an eSIM.
 const fake=mock.signedEvent('payment.succeeded',{...session,status:'succeeded'},{secret:'wrong'}); assert.equal((await deliver(fake)).status,400);
 const expired=mock.signedEvent('payment.succeeded',{...session,status:'succeeded'},{t:Math.floor(Date.now()/1000)-400}); assert.equal((await deliver(expired)).status,400);
 const tampered=mock.signedEvent('payment.succeeded',{...session,status:'succeeded'}); tampered.body=tampered.body.replace('succeeded','failed'); assert.equal((await deliver(tampered)).status,400);
 mock.markPaid(session.id); await call(`/?order=${c.body.orderId}&dpay_status=succeeded`); await order(c.body.orderId); await tick(); await wait(200); assert.equal(mock.state.issueCalls.length,0);
 const evt=mock.signedEvent('payment.succeeded',session);
 const start=Date.now(); assert.equal((await deliver(evt)).status,200); assert.ok(Date.now()-start<10000);
 assert.equal(mock.state.issueCalls.length,0); assert.equal(mock.state.emails.length,0);
 await Promise.all([deliver(evt),deliver(evt),deliver(mock.signedEvent('payment.succeeded',session))]);
 await tick(); await eventually(async()=> (await order(c.body.orderId)).emailStatus==='sent');
 assert.equal(mock.state.issueCalls.length,1); assert.equal(mock.state.issueCalls[0].planId,mock.PLAN_A); assert.equal(mock.state.emails.length,1);
 assert.equal(mock.state.emails[0].to[0].email,'buyer@example.com'); assert.match(mock.state.emails[0].attachment[0].content,/^R0lG/);
 assert.equal((await order(c.body.orderId)).paymentStatus,'paid');
 assert.ok(!JSON.stringify(await order(c.body.orderId)).includes('LPA:'));
 await tick(); await wait(200); assert.equal(mock.state.issueCalls.length,1); assert.equal(mock.state.emails.length,1);
 // Mismatches are held; no Yesim call.
 const mismatch=await create(), s2=[...mock.state.sessions.values()].find(s=>s.order_id===mismatch.body.orderId);
 await deliver(mock.signedEvent('payment.succeeded',{...s2,status:'succeeded',amount:100})); await tick();
 await eventually(async()=> (await order(mismatch.body.orderId)).paymentStatus==='review'); assert.equal(mock.state.issueCalls.length,1);
 // Unknown issuance and email failures are not retried.
 const fail=await create(), s3=[...mock.state.sessions.values()].find(s=>s.order_id===fail.body.orderId);
 mock.state.issueMode='error'; await deliver(mock.signedEvent('payment.succeeded',{...s3,status:'succeeded'})); await tick();
 await eventually(async()=> (await order(fail.body.orderId)).fulfilmentStatus==='review'); await tick(); await wait(200); assert.equal(mock.state.issueCalls.length,2);
 mock.state.issueMode='ok'; mock.state.emailMode='error';
 const ef=await create(), s4=[...mock.state.sessions.values()].find(s=>s.order_id===ef.body.orderId);
 await deliver(mock.signedEvent('payment.succeeded',{...s4,status:'succeeded'})); await tick(); await eventually(async()=> (await order(ef.body.orderId)).emailStatus==='review');
 await tick(); await wait(200); assert.equal(mock.state.issueCalls.length,3); assert.equal(mock.state.emails.length,2);
 // Existing portal top-up is also strictly webhook-driven.
 const tx=await post('/api/checkout',{iccid:'8937204017178100001',planId:mock.PLAN_B,pricePkr:399},{'idempotency-key':crypto.randomUUID()}); assert.equal(tx.status,201);
 const ts=[...mock.state.sessions.values()].find(s=>s.order_id===tx.body.orderId); mock.markPaid(ts.id); await call(`/api/orders/${tx.body.orderId}`); await tick(); await wait(200); assert.equal(mock.state.addPlanCalls.length,0);
 await deliver(mock.signedEvent('payment.succeeded',ts)); await tick(); await eventually(async()=> (await call(`/api/orders/${tx.body.orderId}`)).body.order?.state==='completed'); assert.equal(mock.state.addPlanCalls.length,1);
 const lookup=await post('/api/esim/lookup',{iccid:'8937204017178106954'}); assert.equal(lookup.body.esim.lpa,null);
 console.log('End-to-end checks passed.');
} finally { try{process.kill(-child.pid,'SIGTERM');}catch{} mock.server.close(); await wait(300); rmSync(temp,{recursive:true,force:true}); }
