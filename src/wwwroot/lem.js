// Lem's frontend, in the page it is drawing into.
//
// Upstream's frontend is a separate program that talks to the editor over a
// socket. Here there is no socket and no second program: the editor is on
// another thread of this same runtime, and the messages arrive by being asked
// for. What it sends is unchanged though, so this is an ordinary lem-server
// frontend — a character grid, drawn from "put" and cleared from "clear".

const SEP = String.fromCharCode(31);   // must match lem-page.lisp
const COLS = 100;
const ROWS = 32;
const POLL_MS = 16;

const DEFAULT_FG = '#dcdcdc';
const DEFAULT_BG = '#1e1e28';

const status = document.getElementById('status');
const screen = document.getElementById('screen');
const say = (text, cls) => { status.textContent = text; if (cls) status.classList.add(cls); };

let exports = null;

// ── the grid ─────────────────────────────────────────────────────────────────
//
// One flat array of cells, addressed by row. A cell is what a character needs
// to be drawn: the character and the attributes that came with the "put" that
// wrote it.

const blank = () => ({ ch: ' ', fg: null, bg: null, bold: false, underline: null, reverse: false });
const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, blank));

const views = new Map();     // id → {x, y, width, height, useModeline}
let cursor = null;           // {x, y} in screen coordinates
let dirty = true;

function cell(x, y) {
    if (y < 0 || y >= ROWS || x < 0 || x >= COLS) return null;
    return grid[y][x];
}

function clearRect(x, y, width, height) {
    for (let row = y; row < y + height; row++)
        for (let col = x; col < x + width; col++) {
            const c = cell(col, row);
            if (c) Object.assign(c, blank());
        }
}

// Text arrives as a string with the attributes that apply to all of it. It is
// written by character, not by cell width: a wide character occupies two
// columns on screen, and the second one has to stay empty rather than be
// overwritten by the next character in the string.
function put(view, x, y, text, attribute) {
    const a = attribute || {};
    let col = view.x + x;
    const row = view.y + y;
    for (const ch of text) {
        const c = cell(col, row);
        if (!c) break;
        c.ch = ch;
        c.fg = a.foreground || null;
        c.bg = a.background || null;
        c.bold = !!a.bold;
        c.underline = a.underline || null;
        c.reverse = !!a.reverse;
        col += 1;
        if (wide(ch)) {
            const filler = cell(col, row);
            if (filler) { Object.assign(filler, blank(), { bg: c.bg }); col += 1; }
        }
    }
}

// Enough of East Asian Wide/Fullwidth to keep CJK from shearing the grid. The
// editor already counts columns this way — it sends "textWidth" — so this only
// has to agree with it, not to be a general implementation.
function wide(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf)
        || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
        || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
        || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
}

// ── the messages ─────────────────────────────────────────────────────────────

function viewOf(argument) {
    const info = argument && argument.viewInfo;
    return info ? views.get(info.id) : null;
}

function apply(method, argument) {
    switch (method) {
        case 'make-view':
            views.set(argument.id, {
                x: argument.x, y: argument.y,
                width: argument.width, height: argument.height,
                useModeline: !!argument.use_modeline,
            });
            break;
        case 'delete-view': {
            // Erase it before forgetting it. A view that goes away is not
            // redrawn by anything — the editor only redraws what still exists —
            // so a closed prompt would otherwise stay on the screen forever.
            const v = viewOf(argument);
            if (v) {
                clearRect(v.x, v.y, v.width, v.height + (v.useModeline ? 1 : 0));
                views.delete(argument.viewInfo.id);
                dirty = true;
            }
            break;
        }
        case 'resize-view': {
            const v = viewOf(argument);
            if (v) { v.width = argument.width; v.height = argument.height; }
            break;
        }
        case 'move-view': {
            const v = viewOf(argument);
            if (v) { v.x = argument.x; v.y = argument.y; }
            break;
        }
        case 'clear': {
            const v = viewOf(argument);
            // The modeline row belongs to the view as far as clearing goes;
            // otherwise a deleted window leaves its modeline behind.
            if (v) clearRect(v.x, v.y, v.width, v.height + (v.useModeline ? 1 : 0));
            break;
        }
        case 'clear-eol': {
            const v = viewOf(argument);
            if (v) clearRect(v.x + argument.x, v.y + argument.y, v.width - argument.x, 1);
            break;
        }
        case 'put': {
            const v = viewOf(argument);
            if (v) put(v, argument.x, argument.y, argument.text, argument.attribute);
            break;
        }
        case 'modeline-put': {
            // A view's height excludes its modeline, so the modeline is the row
            // immediately under it and arrives with y = 0 of its own.
            const v = viewOf(argument);
            if (v) put({ x: v.x, y: v.y + v.height }, argument.x, argument.y,
                       argument.text, argument.attribute);
            break;
        }
        case 'move-cursor': {
            const v = viewOf(argument);
            if (v) cursor = { x: v.x + argument.x, y: v.y + argument.y };
            break;
        }
        case 'update-display':
        case 'redraw-view-after':
            dirty = true;
            break;
        case 'page-error':
            say('the editor stopped: ' + (argument && argument.message), 'broken');
            break;
        default:
            // resize-display, update-foreground, set-font, js-eval and the rest:
            // nothing here acts on them yet, and ignoring one costs a repaint at
            // worst. They are not errors.
            break;
    }
}

function receive(text) {
    if (!text) return;
    for (const line of text.split(SEP)) {
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'bulk') {
            for (const one of message.params || []) apply(one.method, one.argument);
        } else if (message.method) {
            apply(message.method, message.params);
        }
        // Anything else is a reply to login or redraw. Nothing waits on them:
        // what proves the editor is alive is the drawing that follows.
    }
}

// ── drawing ──────────────────────────────────────────────────────────────────
//
// Runs of identical attributes become one span. A full redraw of a 100×32
// screen is 3200 cells and typically a few hundred spans, which is cheap enough
// that there is no reason to track damage.

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function style(c, isCursor) {
    let fg = c.fg || DEFAULT_FG;
    let bg = c.bg || DEFAULT_BG;
    if (c.reverse || isCursor) [fg, bg] = [bg, fg];
    const parts = [`color:${fg}`, `background:${bg}`];
    if (c.bold) parts.push('font-weight:600');
    if (c.underline) parts.push('text-decoration:underline');
    return parts.join(';');
}

function render() {
    const rows = [];
    for (let y = 0; y < ROWS; y++) {
        let html = '';
        let run = '';
        let runStyle = null;
        for (let x = 0; x < COLS; x++) {
            const c = grid[y][x];
            const s = style(c, cursor && cursor.x === x && cursor.y === y);
            if (s !== runStyle) {
                if (run) html += `<span style="${runStyle}">${escape(run)}</span>`;
                run = '';
                runStyle = s;
            }
            run += c.ch;
        }
        if (run) html += `<span style="${runStyle}">${escape(run)}</span>`;
        rows.push(`<div class="row">${html}</div>`);
    }
    screen.innerHTML = rows.join('');
}

// ── input ────────────────────────────────────────────────────────────────────
//
// The editor names keys its own way, and the browser names them the DOM's way.
// Only the ones that differ need translating; a printable character is already
// the name Lem uses for it.

const KEY_NAMES = {
    'Enter': 'Return', 'Escape': 'Escape', 'Backspace': 'Backspace', 'Tab': 'Tab',
    'Delete': 'Delete', ' ': 'Space',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
};
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead']);

// One at a time, in the order they were typed. Each call crosses into .NET on
// a pool thread, so two overlapping ones can reach the editor in either order —
// which shows up as characters swapping places while typing quickly.
let sending = Promise.resolve();
function sendToEditor(message) {
    sending = sending.then(() => exports.Playground.LemSend(JSON.stringify(message)));
    return sending;
}

screen.addEventListener('keydown', async (e) => {
    if (MODIFIERS.has(e.key)) return;
    const sym = KEY_NAMES[e.key] || (e.key.length === 1 ? e.key : null);
    if (sym === null) return;
    // Taken before the browser acts on it: Tab would move focus off the screen
    // and Ctrl-N would open a window, and both are Lem's keys here.
    e.preventDefault();
    await sendToEditor({
        jsonrpc: '2.0', method: 'input',
        params: { kind: 'key', value: {
            key: sym,
            ctrl: e.ctrlKey, meta: e.altKey, super: e.metaKey, shift: e.shiftKey,
        } },
    });
});

// ── start ────────────────────────────────────────────────────────────────────

async function start() {
    say('fetching the runtime…');
    const { dotnet } = await import('./_framework/dotnet.js');
    const { getAssemblyExports, getConfig } = await dotnet.create();
    say('loading the image — it has an editor in it, so this takes a moment…');
    exports = await getAssemblyExports(getConfig().mainAssemblyName);

    const booted = await exports.Playground.Boot();
    if (booted !== 'ok') throw new Error(booted);

    // The editor is not in the assembly — it is a file beside this page, so that
    // opening any other page here does not download it. A build without one
    // serves no such file, and LemStart says so.
    const response = await fetch('extra.core');
    if (response.ok) {
        say('loading the editor — it is a large image, so this takes a moment…');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const loaded = await exports.Playground.LoadExtraCore(bytes);
        if (loaded !== 'ok') throw new Error(loaded);
    }

    say('starting the editor…');
    const started = await exports.Playground.LemStart(COLS, ROWS);
    if (started !== 'ok') throw new Error(started);

    // Pull rather than be pushed: the editor draws from its own thread, and a
    // thread that is not this one cannot call in here.
    setInterval(async () => {
        receive(await exports.Playground.LemDrain());
        if (dirty) { dirty = false; render(); }
    }, POLL_MS);

    // The editor is in this image, so a Lisp form evaluated here can ask it what
    // it is doing — including while it is not answering its own input. Kept for
    // that: the page itself never calls it.
    window.lem = {
        eval: (source) => exports.Playground.Run(source),
        send: (message) => sendToEditor(message),
    };

    screen.focus();
    say('ready — click the screen and type', 'ready');
}

render();
start().catch((e) => say('the editor did not start: ' + (e && e.message || e), 'broken'));
