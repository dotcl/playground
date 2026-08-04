// Open the Lem page in headless Chrome, type into it, and photograph the screen.
//
//   node probe-lem.mjs <url> [out.png] [steps]
//
// Steps are separated by "|": either a chord — "C-x", "M-<" — or literal text,
// typed character by character. So 'hello|Enter|C-p|C-a' types a line, opens
// another, and goes back to the start of the first.
//
// The screenshot is the point: everything short of it can be satisfied by an
// editor that answers without drawing. The screen is also dumped as text, twice
// — right after the last key and again after settling — because that is what
// tells "the editor was behind" from "the editor never did it".
//
// Environment:
//   EVAL_BEFORE   Lisp evaluated before typing ("@file" to read it from one).
//                 Goes through window.lem.eval, so it runs in the same image
//                 the editor is in — enough to define a command and then drive
//                 it from the keyboard.
//   EVAL_AFTER    Lisp evaluated afterwards, several forms separated by ";;".
//                 Answers questions the screen cannot: what the buffers are,
//                 which threads are alive, whether a library works at all.
//   KEY_MS        Delay between keystrokes (default 45). The editor can fall
//                 behind a fast typist; raise this before concluding that a
//                 keystroke was lost.
//   SETTLE_MS, BOOT_TIMEOUT_MS, CHROME, CDP_PORT

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [url, outPng, typing] = process.argv.slice(2);
const PORT = Number(process.env.CDP_PORT || 9334);
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 300_000);

const profile = mkdtempSync(join(tmpdir(), 'cdp-lem-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1400,900', 'about:blank',
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
const logs = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((r) => ws.addEventListener('open', r));

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
    logs.push(`[${m.params.type}] ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push(`[exception] ${d.exception?.description || d.text}`);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
    logs.push(`[error] ${m.params.entry.text}`);
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return r.exceptionDetails ? { error: r.exceptionDetails.text } : { value: r.result.value };
};

const t0 = Date.now();
await send('Page.navigate', { url }, sessionId);

let status = '';
let ready = false;
while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
  const r = await evaluate(`(() => { const s = document.getElementById('status');
    return s ? s.textContent + '\\u001f' + s.className : ''; })()`);
  if (r.value) {
    const [text, cls] = r.value.split('\u001f');
    status = text;
    if (cls.includes('ready') || cls.includes('broken')) { ready = cls.includes('ready'); break; }
  }
  await sleep(500);
}
console.log(`status : ${status}`);
console.log(`boot   : ${((Date.now() - t0) / 1000).toFixed(1)} s`);

async function key(k, modifiers = 0) {
  // Only e.key and the modifier flags are read by lem.js, so a keyDown with the
  // DOM key name is the whole event.
  await send('Input.dispatchKeyEvent',
    { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, modifiers },
    sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers }, sessionId);
  await sleep(Number(process.env.KEY_MS || 45));
}

// Steps are separated by "|". A step is either a chord — "C-x", "M-<" — or
// literal text, typed character by character.
const NAMED = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

async function step(token) {
  const chord = /^((?:[CMS]-)+)(.+)$/.exec(token);
  if (chord) {
    let modifiers = 0;
    if (chord[1].includes('M-')) modifiers |= 1;   // Alt
    if (chord[1].includes('C-')) modifiers |= 2;
    if (chord[1].includes('S-')) modifiers |= 8;
    await key(chord[2], modifiers);
  } else if (NAMED.has(token)) {
    await key(token);
  } else {
    for (const ch of token) await key(ch);
  }
}

// Lisp to evaluate before typing anything — "@file" reads it from a file.
// Useful for defining commands the image does not have and then driving them.
if (process.env.EVAL_BEFORE) {
  const source = process.env.EVAL_BEFORE.startsWith('@')
    ? readFileSync(process.env.EVAL_BEFORE.slice(1), 'utf8')
    : process.env.EVAL_BEFORE;
  const r = await send('Runtime.evaluate',
    { expression: `window.lem.eval(${JSON.stringify(source)})`,
      awaitPromise: true, returnByValue: true }, sessionId);
  const [state, printed, values, type, message] =
    String(r.result?.value ?? r.exceptionDetails?.text).split('');
  console.log(`before : ${state === 'ok' ? (printed || '') + values : type + ': ' + message}`);
}

const screenText = async () => {
  const r = await evaluate(`Array.from(document.querySelectorAll('#screen .row'))
    .map((x) => x.textContent.replace(/\\s+$/, '')).filter((l) => l).join('\\n')`);
  return r.value || r.error || '(nothing)';
};

if (ready && typing) {
  await evaluate(`document.getElementById('screen').focus()`);
  for (const token of typing.split('|')) await step(token);
  // Twice, to tell "not processed yet" from "never processed": if these two
  // differ, the editor was merely behind.
  await sleep(200);
  console.log('--- screen, right after the last key ---');
  console.log(await screenText());
  await sleep(Number(process.env.SETTLE_MS || 1500));
}

// Lisp forms to evaluate in the page afterwards, separated by ";;". The value
// comes back as the playground's record; only the printed value matters here.
if (process.env.EVAL_AFTER) {
  for (const form of process.env.EVAL_AFTER.split(';;')) {
    const r = await send('Runtime.evaluate',
      { expression: `window.lem.eval(${JSON.stringify(form)})`,
        awaitPromise: true, returnByValue: true }, sessionId);
    const record = r.result?.value ?? r.exceptionDetails?.text;
    const [state, printed, values, type, message] = String(record).split('');
    console.log(`eval   : ${form}`);
    console.log(`      -> ${state === 'ok' ? (printed || '') + values : type + ': ' + message}`);
  }
}

if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log(`shot   : ${outPng}`);
}

// What is actually on the screen, as text — a screenshot can be looked at, but
// this is what can be asserted on.
const text = await evaluate(`Array.from(document.querySelectorAll('#screen .row'))
  .map((r) => r.textContent.replace(/\\s+$/, '')).filter((l) => l).join('\\n')`);
console.log('--- screen ---');
console.log(text.value || text.error || '(nothing)');

if (logs.length) {
  console.log('--- console ---');
  for (const line of logs.slice(0, 40)) console.log(line);
}

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
