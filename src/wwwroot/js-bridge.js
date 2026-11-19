// The whole of JavaScript, through a handful of functions.
//
// [JSImport] is resolved at build time: a page that wanted createElement,
// appendChild, getContext and the rest as imports would have to name every one
// of them in advance, and Lisp could still only call what the build had thought
// of. So none of them are imported. These are, and everything else is reached
// by name at run time — which is how the Lisp side gets to be the part that
// grows.
//
// Arguments come as one array, so a call takes as many as it likes. What the
// values are on the way in and out is decided in Program.cs, not here; the one
// thing this file has to do for it is undefined, which the marshaller would
// otherwise turn into null in both directions.

const UNDEFINED = Object.freeze({});

// The marshaller will not carry a function as "any", and carries an array as a
// copy, so either leaves here in a box — a reference, as other objects are —
// and is taken out of it when it comes back.
class Box { constructor(x) { this.x = x; } }
const out = (x) => (typeof x === 'function' || Array.isArray(x) || ArrayBuffer.isView(x)
                    ? new Box(x) : x);

const value = (x) => (x === UNDEFINED ? undefined : x instanceof Box ? x.x : x);
const values = (xs) => xs.map(value);

// What the last call that threw threw, for Program.cs to take apart. The
// exception the marshaller hands over carries only a message.
let thrown;
const guard = (f) => { try { return f(); } catch (e) { thrown = e; throw e; } };

export function undefinedMarker() { return UNDEFINED; }
export function lastThrown() { const e = thrown; thrown = undefined; return e; }
export function nameOf(e) { return e instanceof Error ? e.name : null; }
export function messageOf(e) { return e instanceof Error ? e.message : String(e); }

export function get(target, key) { return guard(() => out(value(target)[value(key)])); }
export function set(target, key, x) { guard(() => { value(target)[value(key)] = value(x); }); }
export function call(target, key, args) {
    return guard(() => { const t = value(target); return out(t[value(key)](...values(args))); });
}
export function apply(f, args) { return guard(() => out(value(f)(...values(args)))); }
export function construct(c, args) { return guard(() => out(new (value(c))(...values(args)))); }
export function array(items) { return out(values(items)); }
export function typeOf(x) { x = value(x); return x === null ? 'null' : typeof x; }

// A Lisp function as a JavaScript one, which an event can call. It does not
// wait for the Lisp: this thread may not call managed code synchronously in the
// threaded build, and code that did would block the page while it ran. So the
// call is handed to an asynchronous export and returns undefined at once — a
// listener works, a callback whose value is wanted (map, sort) does not.
let exportsOf;
const deliver = (id, args) => {
    const runtime = globalThis.getDotnetRuntime(0);
    exportsOf ??= runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    exportsOf.then((e) => e.Playground.JsDeliver(id, args));
};
export function wrap(id) { return new Box((...args) => { deliver(id, args.map(out)); }); }
