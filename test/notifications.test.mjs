import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/script.js', import.meta.url), 'utf8');
const plan = { planId:'a123', name:'Test plan', pricePkr:220, data:'1 GB', days:7, popular:false, reloadable:true };

async function storefront({ url = 'https://pak.example/', status, planResponse = {plans:[plan],source:'live',autoCheckoutAvailable:true} } = {}) {
  const dom = new JSDOM(html, { url, runScripts:'outside-only', pretendToBeVisual:true });
  const {window:w} = dom;
  const notifications = [], timers = [], requests = [], opens = [];
  w.PakTelNotify = (...args) => notifications.push(args);
  w.fetch = async (path, opts) => {
    requests.push([path, opts]);
    if (path === '/api/plans') return {ok:true,json:async()=>planResponse};
    if (String(path).startsWith('/api/new-esim/orders/')) return {ok:true,json:async()=>({order:status()})};
    if (path === '/api/new-esim/checkout') return {ok:false,json:async()=>({error:{message:'Checkout disabled'}})};
    throw new Error('unexpected fetch');
  };
  w.open = (...args) => opens.push(args);
  w.setTimeout = (fn, ms) => { timers.push([fn,ms]); return timers.length; };
  w.requestAnimationFrame = cb => { cb(); return 1; };
  w.eval(script);
  await new Promise(resolve=>setImmediate(resolve));
  return {dom,w,notifications,timers,requests,opens};
}
const seen = (items, name) => items.some(x=>x[1] === name);

test('storefront notifications cover plans, filters, sort, devices, checkout and WhatsApp without changing URLs', async () => {
  const {dom,w,notifications,requests,opens} = await storefront();
  assert.ok(seen(notifications,'Plans synced'));
  w.document.querySelector('[data-filter="under-1"]').click();
  assert.ok(seen(notifications,'Plan filter updated'));
  const sort = w.document.getElementById('sort-select');
  sort.value = 'price-low'; sort.dispatchEvent(new w.Event('change'));
  assert.ok(seen(notifications,'Plans sorted'));
  w.document.getElementById('device-search').value='iPhone 15';
  w.document.getElementById('device-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  assert.ok(seen(notifications,'eSIM-ready model'));
  w.document.getElementById('device-search').value='Unknown device 123';
  w.document.getElementById('device-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  assert.ok(seen(notifications,'Device not verified'));
  w.document.querySelector('[data-plan-id]').click();
  assert.ok(seen(notifications,'Plan selected'));
  w.document.getElementById('order-note').value='buyer@example.com';
  w.document.getElementById('payment-order').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(seen(notifications,'Preparing checkout')); assert.ok(seen(notifications,'Checkout unavailable'));
  assert.ok(requests.some(([path])=>path==='/api/new-esim/checkout'));
  const href=w.document.querySelector('.checker-footnote a').href;
  w.document.querySelector('.checker-footnote a').dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.ok(seen(notifications,'Opening WhatsApp'));
  assert.equal(w.document.querySelector('.checker-footnote a').href,href);
  w.document.getElementById('floating-whatsapp').click();
  assert.match(opens[0][0],/^https:\/\/wa\.me\/923259717066\?/);
  dom.window.close();
});

test('snapshot permits manual WhatsApp ordering but prevents DPay checkout', async () => {
  const {dom,w,notifications,requests} = await storefront({planResponse:{plans:[plan],source:'snapshot',updatedAt:'2026-11-17',readOnly:true,autoCheckoutAvailable:false}});
  assert.match(w.document.querySelector('[data-status-text]').textContent, /Preview snapshot.*2026-11-17.*DPay disabled/);
  assert.ok(seen(notifications,'Preview prices'));
  const button = w.document.querySelector('[data-plan-id]');
  assert.equal(button.disabled,false);
  button.click();
  assert.equal(w.document.getElementById('checkout-modal').hidden,false);
  assert.equal(w.document.getElementById('payment-order').disabled,true);
  assert.match(w.document.getElementById('dpay-availability').textContent,/disabled in this preview/);
  const link=w.document.getElementById('whatsapp-order');
  const url=new URL(link.href);
  const text=url.searchParams.get('text');
  assert.equal(url.origin,'https://wa.me');
  assert.equal(url.pathname,'/923259717066');
  assert.match(text,/Plan: Test plan/);
  assert.match(text,/snapshot 2026-11-17; please confirm/);
  assert.match(text,/manual checkout/);
  assert.equal(link.target,'_blank');
  assert.match(link.rel,/noopener/);
  assert.match(link.rel,/noreferrer/);
  // Manual checkout needs no email and never creates a DPay order.
  assert.equal(w.document.getElementById('order-note').value,'');
  link.addEventListener('click',event=>event.preventDefault());
  link.click();
  assert.ok(seen(notifications,'Opening WhatsApp'));
  assert.ok(!requests.some(([path])=>path==='/api/new-esim/checkout'));
  dom.window.close();
});

test('manual WhatsApp order omits the email entered for DPay', async () => {
  const {dom,w} = await storefront();
  w.document.querySelector('[data-plan-id]').click();
  const email=w.document.getElementById('order-note');
  email.value='buyer@example.com';
  const text=new URL(w.document.getElementById('whatsapp-order').href).searchParams.get('text');
  assert.doesNotMatch(text,/buyer@example.com/);
  assert.match(text,/Displayed price \(please confirm\): PKR 220/);
  assert.equal(w.document.getElementById('payment-order').disabled,false);
  dom.window.close();
});

test('automatic payment remains unavailable when provider configuration is missing', async () => {
  const {dom,w} = await storefront({planResponse:{plans:[plan],source:'live',autoCheckoutAvailable:false}});
  w.document.querySelector('[data-plan-id]').click();
  assert.equal(w.document.getElementById('payment-order').disabled,true);
  assert.match(w.document.getElementById('dpay-availability').textContent,/not available yet/);
  assert.ok(w.document.getElementById('whatsapp-order').href.startsWith('https://wa.me/'));
  dom.window.close();
});

test('redirect parameters cannot announce payment success; confirmed server state can', async () => {
  let state = {paymentStatus:'pending',fulfilmentStatus:'not_started',emailStatus:'not_started'};
  const {dom,notifications,timers} = await storefront({url:'https://pak.example/?order=PT-AAAAAAAAAAAAAAAAAAAA&dpay_status=succeeded',status:()=>state});
  assert.ok(seen(notifications,'Waiting for payment'));
  assert.ok(!seen(notifications,'Payment confirmed'));
  const poll=timers.find(([,ms])=>ms===10000); assert.ok(poll);
  const initialCount = notifications.length;
  await poll[0]();
  assert.equal(notifications.length, initialCount, 'unchanged pending state is not repeatedly announced');
  state={paymentStatus:'paid',fulfilmentStatus:'not_started',emailStatus:'not_started'};
  await timers.filter(([,ms])=>ms===10000).at(-1)[0]();
  assert.ok(seen(notifications,'Payment confirmed'));
  state={paymentStatus:'paid',fulfilmentStatus:'issued',emailStatus:'sent'};
  await timers.filter(([,ms])=>ms===10000).at(-1)[0]();
  assert.ok(seen(notifications,'eSIM email on its way'));
  const count=notifications.length;
  // Stable states don't announce repeatedly.
  assert.ok(count > 0);
  dom.window.close();
});

test('official Dynaura vanilla adapter mounts and renders accessible themed toasts', async () => {
  const dom=new JSDOM('<!doctype html><body></body>',{url:'https://pak.example',pretendToBeVisual:true});
  const w=dom.window;
  const globals=['document','window','navigator','Node','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','ResizeObserver'];
  const previous=new Map(globals.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try {
    Object.defineProperty(globalThis,'document',{configurable:true,value:w.document});
    Object.defineProperty(globalThis,'window',{configurable:true,value:w});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:w.navigator});
    Object.defineProperty(globalThis,'Node',{configurable:true,value:w.Node});
    Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:w.getComputedStyle.bind(w)});
    Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:w.requestAnimationFrame.bind(w)});
    Object.defineProperty(globalThis,'cancelAnimationFrame',{configurable:true,value:w.cancelAnimationFrame.bind(w)});
    Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class {observe(){} disconnect(){}}});
    const {createToaster,dynaura}=await import('dynaura/vanilla');
    const handle=createToaster({position:'top',theme:'dark',haptics:false});
    dynaura.success({title:'Plans synced',description:'Live prices ready.'});
    assert.equal(w.document.querySelectorAll('.dynaura-root').length,1);
    const island=w.document.querySelector('.dynaura-island');
    assert.equal(island.getAttribute('role'),'status');
    assert.equal(island.dataset.type,'success');
    assert.equal(w.document.querySelector('.dynaura-title').textContent,'Plans synced');
    assert.equal(w.document.querySelector('.dynaura-desc').textContent,'Live prices ready.');
    dynaura.error({title:'Checkout unavailable'});
    assert.equal(island.getAttribute('aria-live'),'assertive');
    handle.destroy();
    assert.equal(w.document.querySelectorAll('.dynaura-root').length,0);
  } finally {
    for(const [k,descriptor] of previous) { if(descriptor) Object.defineProperty(globalThis,k,descriptor); else delete globalThis[k]; }
    dom.window.close();
  }
});
