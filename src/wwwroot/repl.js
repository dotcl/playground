// dotcl's own REPL — line editing, completion menus, the debugger — on an
// xterm. The REPL thinks it is reading keys from a console; repl-page.lisp
// and Program.cs make this page that console.
//
// Keys go one way as System.ConsoleKeyInfo terms, text comes the other way as
// whatever the REPL wrote, escape sequences and all, and xterm draws it.

const POLL_MS = 16;

// The contrib modules repl-page.lisp needs, fetched from contrib/ at start.
const CONTRIB = ['dotcl-gray', 'dotcl-code-info', 'dotcl-repl'];

const status = document.getElementById('status');
const say = (text, cls) => { status.textContent = text; if (cls) status.classList.add(cls); };

const term = new Terminal({
    // The REPL writes "\n" as a console program does and leaves the carriage
    // return to the terminal driver, which a browser does not have.
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 14,
    theme: { background: '#14141c' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

let exports = null;
const send = (ch, key, shift = false, alt = false, ctrl = false) =>
    exports && exports.Playground.ReplKey(ch, key, shift, alt, ctrl);

// ── keys ─────────────────────────────────────────────────────────────────────
//
// System.ConsoleKey values for the keys that are not characters. The editor
// tells them apart by Key; for everything printable it reads KeyChar.

const NAMED = {
    Backspace: [8, 8], Tab: [9, 9], Enter: [13, 13], Escape: [27, 27],
    PageUp: [0, 33], PageDown: [0, 34], End: [0, 35], Home: [0, 36],
    ArrowLeft: [0, 37], ArrowUp: [0, 38], ArrowRight: [0, 39], ArrowDown: [0, 40],
    Insert: [0, 45], Delete: [0, 46],
};

// The ConsoleKey a character is typed with: letters and digits have their own,
// and the rest are left to KeyChar.
function keyOf(c) {
    const u = c.toUpperCase();
    if (u >= 'A' && u <= 'Z' && u.length === 1) return u.charCodeAt(0);
    if (c >= '0' && c <= '9') return c.charCodeAt(0);
    if (c === ' ') return 32;
    return 0;
}

term.attachCustomKeyEventHandler((e) => {
    // keypress and keyup: whatever keydown did not take is xterm's.
    if (e.type !== 'keydown') return !(e.ctrlKey || e.altKey);
    const named = NAMED[e.key];
    if (named) {
        send(named[0], named[1], e.shiftKey, e.altKey, e.ctrlKey);
        e.preventDefault();
        return false;
    }
    // Ctrl+V and Ctrl+Shift+V paste: leave them to the browser, which hands the
    // text to xterm, which hands it to onData below.
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) return false;
    if ((e.ctrlKey || e.altKey) && e.key.length === 1) {
        const key = keyOf(e.key);
        // Ctrl+C interrupts a form being evaluated; with none, it is a key for
        // the editor, which drops the line, as at a console.
        if (e.ctrlKey && key === 67) {
            exports && exports.Playground.ReplInterrupt().then((r) => { if (r !== 't') send(3, 67, false, false, true); });
        } else {
            const ch = e.ctrlKey && key >= 65 && key <= 90 ? key - 64 : e.key.charCodeAt(0);
            send(ch, key, e.shiftKey, e.altKey, e.ctrlKey);
        }
        e.preventDefault();
        return false;
    }
    return true;   // a plain character: xterm turns it into onData
});

// Typed characters, pastes and IME input. A paste arrives wrapped in the
// bracketed paste sequence when the REPL asked for it; the editor reads that
// sequence itself, a character at a time, so it is passed on as it is.
term.onData((data) => {
    for (const c of data) {
        if (c === '\x1b') send(27, 27);
        else if (c === '\r' || c === '\n') send(13, 13);
        else if (c === '\x7f') send(8, 8);
        else send(c.codePointAt(0) > 0xffff ? 0xfffd : c.charCodeAt(0), keyOf(c), c !== c.toLowerCase());
    }
});

term.onResize(({ cols, rows }) => exports && exports.Playground.ReplResize(cols, rows));
window.addEventListener('resize', () => fit.fit());

// ── start ────────────────────────────────────────────────────────────────────

async function start() {
    // coi.js is reloading the page through its worker; this copy is discarded.
    if (await window.coi) return new Promise(() => {});
    if (!window.crossOriginIsolated)
        throw new Error('the REPL needs threads, and threads need this page to be cross-origin isolated');
    say('fetching the runtime…');
    const { dotnet } = await import('./_framework/dotnet.js');
    const { getAssemblyExports, getConfig } = await dotnet.create();
    say('loading the Lisp core…');
    exports = await getAssemblyExports(getConfig().mainAssemblyName);
    const booted = await exports.Playground.Boot();
    if (booted !== 'ok') throw new Error(booted);

    // Served beside the page rather than embedded, so that only this page pays
    // for them. dotcl-code-info is what TAB completes from; the REPL starts
    // without it, so a missing one is not fatal.
    say('fetching the REPL…');
    for (const name of CONTRIB) {
        const res = await fetch(`contrib/${name}.fasl`);
        if (!res.ok) {
            if (name === 'dotcl-code-info') continue;
            throw new Error(`contrib/${name}.fasl: ${res.status}`);
        }
        const added = await exports.Playground.ReplAddContrib(
            `${name}.fasl`, new Uint8Array(await res.arrayBuffer()));
        if (added !== 'ok') throw new Error(added);
    }

    say('starting the REPL…');
    const started = await exports.Playground.ReplStart(term.cols, term.rows);
    if (started !== 'ok') throw new Error(started);

    // Pull rather than be pushed: the REPL writes from its own thread, and a
    // thread that is not this one cannot call in here.
    const drain = async () => {
        const text = await exports.Playground.ReplDrain();
        if (text) term.write(text);
        setTimeout(drain, POLL_MS);
    };
    drain();

    // For probing from outside: evaluate in the same image the REPL is in.
    window.repl = { eval: (source) => exports.Playground.Run(source) };

    term.focus();
    say('ready — Ctrl+C interrupts, ,help lists the commands', 'ready');
}

start().catch((e) => say('the REPL did not start: ' + (e && e.message || e), 'broken'));
