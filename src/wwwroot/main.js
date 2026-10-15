// Turns every <pre class="lisp"> on the page into something you can run and edit.
//
// The prose is plain HTML. Nothing here knows what the chapters say, so writing
// a new chapter means writing a new <pre> and no JavaScript at all.

const SEP = String.fromCharCode(31);   // must match prelude.lisp and Program.cs

// ── the engine ───────────────────────────────────────────────────────────────
//
// Boot and Run are async on both sides, which is not a stylistic choice: with
// -p:WasmEnableThreads=true the runtime moves off the page thread and refuses
// synchronous calls outright ("Cannot call synchronous C# methods"). Keeping the
// boundary async means the same page works either way — single-threaded, where
// Lisp runs here and a long block freezes the tab, or threaded, where it does
// not. See the README for what the threaded build costs to host.

let exports = null;
let ready = null;

const status = document.getElementById('status');
const say = (text, cls) => { status.textContent = text; if (cls) status.classList.add(cls); };

async function start() {
    // coi.js is reloading the page through its worker; this copy is discarded.
    if (await window.coi) return new Promise(() => {});
    say('fetching the runtime…');
    const { dotnet } = await import('./_framework/dotnet.js');
    const { getAssemblyExports, getConfig } = await dotnet.create();
    say('loading the Lisp core…');
    exports = await getAssemblyExports(getConfig().mainAssemblyName);
    const result = await exports.Playground.Boot();
    if (result !== 'ok') throw new Error(result);
}

async function evaluate(source) {
    await ready;
    // Let the browser paint the "running" state before we take the thread away.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return await exports.Playground.Run(source);
}

// ── running a block ──────────────────────────────────────────────────────────

const blocks = [];          // every runnable block, in document order
const executed = new Set(); // indices whose text has been evaluated

function parseRecord(record) {
    const [state, output, values, type, message, restarts] = record.split(SEP);
    return { ok: state === 'ok', output, values, type, message,
             restarts: restarts ? restarts.split(' ').filter(Boolean) : [] };
}

async function runBlock(i, opts = {}) {
    const b = blocks[i];

    // A reader who followed a link into the middle of a page has run nothing
    // above, and the blocks share one image on purpose. Catch them up — unless
    // this block is marked as standing alone.
    if (!opts.quiet && b.auto) {
        const missing = [];
        for (let j = 0; j < i; j++) if (blocks[j].auto && !executed.has(j)) missing.push(j);
        if (missing.length) {
            b.note.textContent = `running ${missing.length} earlier block${missing.length > 1 ? 's' : ''} first`;
            for (const j of missing) await runBlock(j, { quiet: true });
            b.note.textContent = '';
        }
    }

    b.el.classList.add('running');
    try {
        render(b, parseRecord(await evaluate(b.editor.value)));
        executed.add(i);
    } finally {
        b.el.classList.remove('running');
    }
}

function render(b, r) {
    b.out.hidden = false;
    b.out.textContent = '';
    const add = (cls, text) => {
        if (!text) return;
        const el = document.createElement('div');
        el.className = cls;
        el.textContent = text;
        b.out.appendChild(el);
    };
    add('printed', r.output);
    if (r.ok) {
        add('value', r.values || '; no value');
    } else {
        add('error', `${r.type}: ${r.message}`);
        // The page cannot offer to invoke them yet, but showing that an error
        // arrives carrying a menu of ways to continue is the part people do not
        // expect — and the part a subset implementation cannot show at all.
        if (r.restarts.length) add('restarts', 'restarts available: ' + r.restarts.join(', '));
    }
}

// ── sharing ──────────────────────────────────────────────────────────────────
//
// The code goes in the fragment, so nothing is sent to the server and the page
// stays a static file.

async function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let packed = bytes;
    if (typeof CompressionStream === 'function') {
        const cs = new CompressionStream('deflate-raw');
        const w = cs.writable.getWriter(); w.write(bytes); w.close();
        packed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    }
    let s = '';
    for (const byte of packed) s += String.fromCharCode(byte);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decode(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (typeof DecompressionStream !== 'function') return new TextDecoder().decode(bytes);
    try {
        const ds = new DecompressionStream('deflate-raw');
        const w = ds.writable.getWriter(); w.write(bytes); w.close();
        return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
    } catch { return new TextDecoder().decode(bytes); }
}

// ── building the blocks ──────────────────────────────────────────────────────

function makeBlock(pre) {
    const source = pre.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    const el = document.createElement('div');
    el.className = 'block';
    el.innerHTML = `<textarea spellcheck="false"></textarea>
<div class="bar"><button class="run">Run</button>
<button class="share">Copy link</button><span class="note"></span></div>
<pre class="out" hidden></pre>`;

    const b = {
        el,
        editor: el.querySelector('textarea'),
        out: el.querySelector('.out'),
        note: el.querySelector('.note'),
        auto: pre.dataset.standalone === undefined,
    };
    b.editor.value = source;

    const grow = () => {
        b.editor.style.height = 'auto';
        b.editor.style.height = b.editor.scrollHeight + 'px';
    };
    b.editor.addEventListener('input', grow);
    // Ctrl/Cmd+Enter runs, because everyone tries it.
    b.editor.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            el.querySelector('.run').click();
        }
    });

    const i = blocks.length;
    blocks.push(b);
    el.querySelector('.run').addEventListener('click', () => runBlock(i));
    el.querySelector('.share').addEventListener('click', async () => {
        const url = location.origin + location.pathname + '#try=' + await encode(b.editor.value);
        await navigator.clipboard.writeText(url).catch(() => {});
        b.note.textContent = 'link copied';
        setTimeout(() => { b.note.textContent = ''; }, 2000);
    });

    pre.replaceWith(el);
    requestAnimationFrame(grow);
    return b;
}

// ── start ────────────────────────────────────────────────────────────────────

document.querySelectorAll('pre.lisp').forEach(makeBlock);

// A shared snippet becomes a block of its own at the top: whoever followed the
// link came for that code, not for the chapter it was taken from.
const shared = new URLSearchParams(location.hash.slice(1)).get('try');
if (shared) {
    const pre = document.createElement('pre');
    pre.className = 'lisp';
    pre.dataset.standalone = '';
    pre.textContent = await decode(shared);
    const host = document.getElementById('shared');
    host.hidden = false;
    host.appendChild(pre);
    makeBlock(pre);
}

ready = start();
ready.then(
    () => say('ready', 'ready'),
    (e) => say('the Lisp did not start: ' + (e && e.message || e), 'broken'));
