// The whole of JavaScript, through five functions.
//
// [JSImport] is resolved at build time: a page that wanted createElement,
// appendChild, getContext and the rest as imports would have to name every one
// of them in advance, and Lisp could still only call what the build had thought
// of. So none of them are imported. These are, and everything else is reached
// by name at run time — which is how the Lisp side gets to be the part that
// grows.
//
// Arities are spelled out rather than taken as an array because the import
// signature has to be fixed anyway, and fixed arities marshal every argument as
// itself. An array would have meant wrapping each one first.

export function get(target, name) { return target[name]; }

export function set(target, name, value) { target[name] = value; }

export function call0(target, name) { return target[name](); }
export function call1(target, name, a) { return target[name](a); }
export function call2(target, name, a, b) { return target[name](a, b); }
export function call3(target, name, a, b, c) { return target[name](a, b, c); }
export function call4(target, name, a, b, c, d) { return target[name](a, b, c, d); }
// Six because arc(x, y, r, from, to, anticlockwise) is six and a bridge that
// cannot draw a circle is not finished. Anything wider — drawImage takes nine —
// wants a shim function of its own rather than another arity here.
export function call5(target, name, a, b, c, d, e) { return target[name](a, b, c, d, e); }
export function call6(target, name, a, b, c, d, e, f) { return target[name](a, b, c, d, e, f); }

export function construct0(name) { return new globalThis[name](); }
export function construct1(name, a) { return new globalThis[name](a); }

// A callback, so Lisp can be an event handler. The managed side hands over a
// function it already knows how to hold on to; this only forwards the event.
export function on(target, event, handler) {
    target.addEventListener(event, (e) => handler(e));
}
