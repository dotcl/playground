// Drive the playground in headless Chrome and report what the page says.
//
//   node probe-page.mjs <url> [lisp-expression | @file]
//
// Reports: time to boot, the status line, any console errors, and — if an
// expression was given — what the first block prints when it is run with that
// expression in it.
//
// The page has to be served over HTTP; file:// does not work for WebAssembly.
//
// Environment: CHROME (path to the browser), CDP_PORT, BOOT_TIMEOUT_MS.
//
// This exists because "it published without errors" says nothing about whether
// the page runs: the trimmer removes what only Lisp calls, and a core that
// fails to load fails in the browser and nowhere else.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [url, exprArg] = process.argv.slice(2);
// @file reads the expression from a file, so shell quoting stays out of the Lisp.
const expr = exprArg && exprArg.startsWith('@')
  ? readFileSync(exprArg.slice(1), 'utf8') : exprArg;
const PORT = Number(process.env.CDP_PORT || 9333);
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 180_000);
const RUN_TIMEOUT_MS = 120_000;

const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--js-flags=--max-old-space-size=4096', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function debuggerUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('chrome never opened its debugging port');
}

let nextId = 1;
const pending = new Map();
const console_ = [];

function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((r) => ws.addEventListener('open', r));

let sessionId = null;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    console_.push(`[${m.params.type}] ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console_.push(`[exception] ${d.exception?.description || d.text}`);
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') console_.push(`[${e.level}] ${e.text}`);
  }
});

const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
({ sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true }));
await send(ws, 'Runtime.enable', {}, sessionId);
await send(ws, 'Log.enable', {}, sessionId);
await send(ws, 'Page.enable', {}, sessionId);

async function evaluate(expression, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: r.result.value };
}

const t0 = Date.now();
await send(ws, 'Page.navigate', { url }, sessionId);

let status = '';
let bootMs = null;
while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
  const r = await evaluate(`(() => { const s = document.getElementById('status');
    return s ? s.textContent + '\\u001f' + s.className : ''; })()`);
  if (r.value) {
    const [text, cls] = r.value.split('\u001f');
    status = text;
    if (cls.includes('ready') || cls.includes('broken')) { bootMs = Date.now() - t0; break; }
  }
  await sleep(500);
}

console.log(`status   : ${status}`);
console.log(`boot     : ${bootMs === null ? 'TIMED OUT after ' + BOOT_TIMEOUT_MS + ' ms' : (bootMs / 1000).toFixed(1) + ' s'}`);

if (expr && status === 'ready') {
  const set = await evaluate(`(() => {
    const b = document.querySelector('.block');
    if (!b) return 'no block on the page';
    b.querySelector('textarea').value = ${JSON.stringify(expr)};
    b.querySelector('.out').textContent = '';
    b.querySelector('.out').hidden = true;
    b.querySelector('.run').click();
    return 'clicked';
  })()`);
  console.log(`run      : ${set.value || set.error}`);
  const t1 = Date.now();
  let out = null;
  while (Date.now() - t1 < RUN_TIMEOUT_MS) {
    const r = await evaluate(`(() => { const o = document.querySelector('.block .out');
      return o && !o.hidden ? o.textContent : null; })()`);
    if (r.value) { out = r.value; break; }
    await sleep(500);
  }
  console.log(`output   : ${out === null ? 'TIMED OUT' : out}`);
}

if (console_.length) {
  console.log('--- console ---');
  for (const line of console_.slice(0, 60)) console.log(line);
}

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
