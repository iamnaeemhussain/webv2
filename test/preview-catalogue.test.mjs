import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercise the real Worker with D1. The upstream begins unavailable and then recovers.
test('offline catalogue preview is read-only and returns to live data when available', async () => {
  const mockPort=18792, port=18798;
  let available=false;
  const server=http.createServer((req,res)=>{
    if (!available) { res.writeHead(503); res.end(); return; }
    res.writeHead(200,{'content-type':'text/csv'});
    res.end('Plan Name,Price (PKR),GBs,Days,Reloadable,Most Popular,Actual Price,Discount %,Cost,Commission,Contact,EUR to PKR,Plan ID\nLive Test,500,1 GB,7 Days,Yes,,600,17%,private,private,private,private,abc123\n');
  });
  await new Promise(r=>server.listen(mockPort,'127.0.0.1',r));
  const temp=mkdtempSync(path.join(tmpdir(),'pak-preview-test-'));
  const vars={PREVIEW_CATALOGUE:'true',ENABLE_NEW_ESIM_SALES:'true',YESIM_API_TOKEN:'test',DPAY_API_KEY:'test',DPAY_WEBHOOK_SECRET:'test',BREVO_API_KEY:'test',BREVO_SENDER_EMAIL:'sender@example.com',PUBLIC_BASE_URL:'https://pak.example',PLANS_SHEET_CSV_URL:`http://127.0.0.1:${mockPort}/sheet.csv`};
  const args=['dev','--ip','127.0.0.1','--port',String(port),'--inspector-port','19413','--persist-to',temp,'--show-interactive-dev-session=false'];
  for (const [k,v] of Object.entries(vars)) args.push('--var',`${k}:${v}`);
  const child=spawn('./node_modules/.bin/wrangler',args,{stdio:'ignore',detached:true});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const base=`http://127.0.0.1:${port}`;
  const call=async (route,options={})=>{const r=await fetch(base+route,{signal:AbortSignal.timeout(3000),...options}); return {status:r.status,body:await r.json()};};
  try {
    let ready=false;
    for(let i=0;i<100 && !ready;i++){try{ready=(await call('/api/health')).status===200;}catch{} if(!ready) await wait(100);}
    assert.ok(ready,'worker started');
    const offline=await call('/api/plans');
    assert.equal(offline.status,200);
    assert.equal(offline.body.source,'snapshot');
    assert.equal(offline.body.updatedAt,'2026-11-17');
    assert.equal(offline.body.readOnly,true);
    assert.equal(offline.body.autoCheckoutAvailable,false);
    assert.equal(offline.body.plans.length,11);
    assert.equal(offline.body.plans[0].pricePkr,220);
    assert.ok(!JSON.stringify(offline.body).includes('commission'));
    const headers={'content-type':'application/json','idempotency-key':'1234567890abcdef'};
    for(const route of ['/api/checkout','/api/new-esim/checkout']) {
      const response=await call(route,{method:'POST',headers,body:'{}'});
      assert.equal(response.status,503);
      assert.equal(response.body.error.code,'preview_read_only');
    }
    available=true;
    const online=await call('/api/plans');
    assert.equal(online.body.source,'live');
    assert.equal(online.body.readOnly,true);
    assert.equal(online.body.autoCheckoutAvailable,false);
    assert.equal(online.body.plans[0].name,'Live Test');
    assert.ok(!JSON.stringify(online.body).includes('private'));
  } finally {
    try{process.kill(-child.pid,'SIGTERM');}catch{}
    server.close(); await wait(300); rmSync(temp,{recursive:true,force:true});
  }
});
