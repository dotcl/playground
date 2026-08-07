// Boot the Lisp, then run every <script type="text/common-lisp"> on the page.
//
// The browser does not execute a script whose type is not JavaScript, and does
// not fetch its src either — the element just sits in the DOM as text. So it
// serves as a carrier: the runtime finds the tags itself and evaluates what is
// in them. Brython does this for Python; WECL does it for ECL.

const SEP = String.fromCharCode(31);   // must match prelude.lisp

const status = document.getElementById('status');
const say = (text, cls) => { status.textContent = text; if (cls) status.classList.add(cls); };

async function start() {
    say('fetching the runtime…');
    const { dotnet } = await import('./_framework/dotnet.js');
    const { getAssemblyExports, getConfig } = await dotnet.create();
    say('loading the Lisp…');
    const exports = await getAssemblyExports(getConfig().mainAssemblyName);

    const booted = await exports.Playground.Boot();
    if (booted !== 'ok') throw new Error(booted);

    const blocks = document.querySelectorAll('script[type="text/common-lisp"]');
    say(`running ${blocks.length} block${blocks.length === 1 ? '' : 's'}…`);
    for (const block of blocks) {
        // src is honoured here because nothing else will: the browser ignores it
        // on a script tag it does not recognise.
        const source = block.src
            ? await (await fetch(block.src)).text()
            : block.textContent;
        const record = await exports.Playground.Run(source);
        const [state, output, , type, message] = record.split(SEP);
        if (state !== 'ok') throw new Error(`${type}: ${message}`);
        if (output) console.log(output);
    }
    say('done — everything above was drawn by the Lisp in this page', 'ready');
}

start().catch((e) => say('the Lisp did not run: ' + (e && e.message || e), 'broken'));
