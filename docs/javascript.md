# Calling JavaScript from Lisp

In the [playground](https://dotcl.github.io/playground/), dotcl runs in the
browser, and the `js:` package reaches the page it runs in: the document, the
DOM, `Math`, `JSON`, anything on `globalThis`. Every form below was run in the
playground and shows its real result.

The names, and what they do to values crossing over, are those of the `JS`
package of [clysm](https://github.com/cxxxr/clysm) (`runtime/js.lisp`), another
Common Lisp for WebAssembly. Code written against one reads the same against the
other. [Where it differs](#where-it-differs-from-clysm) is listed at the end.

The `js:` package exists in the browser build only. On the desktop the same job
is done by the `dotnet:` package; see
[Calling .NET from Lisp](https://github.com/dotcl/dotcl/blob/master/docs/dotnet-package.md).

## Properties, methods, functions, constructors

Everything starts at `js:global`, which is `globalThis`. Given a name, it is
that property of it:

```lisp
(js:global)                                       ; => #<DOTNET System.Runtime.InteropServices.JavaScript.JSObject (js-obj js '3')>
(js:get (js:global "Math") "PI")                  ; Math.PI          => 3.141592653589793d0
(js:call (js:global "Math") "max" 1 5 3)          ; Math.max(1, 5, 3) => 5
(js:call "abc" "toUpperCase")                     ; "abc".toUpperCase() => "ABC"
```

A property is not a method, and the names say which is meant. `js:get` reads a
property, `js:set` writes one and returns the value, and `js:call` calls a
method on the object it belongs to:

```lisp
(let ((o (js:object "a" 1)))
  (js:set o "b" 2)
  (js:call (js:global "JSON") "stringify" o))     ; => "{\"a\":1,\"b\":2}"
```

`js:funcall` calls a function with `this` undefined, `js:new` calls a
constructor, and `js:eval` evaluates a string of JavaScript:

```lisp
(js:funcall (js:global "parseInt") "ff" 16)       ; parseInt("ff", 16) => 255
(js:call (js:new (js:global "Date") 0) "toISOString")
                                                  ; new Date(0).toISOString() => "1970-01-01T00:00:00.000Z"
(js:eval "[1, 2, 3].length")                      ; => 3
```

There is no limit on the number of arguments:

```lisp
(js:call (js:global "Math") "hypot" 1 2 2 4 4 6 8 10)  ; => 15.524174696260024d0
```

A property that is not there is `NIL`, as `undefined` is:

```lisp
(js:get (js:global) "noSuchProperty")             ; => NIL
```

`js:log` writes to the browser's console and returns `NIL`:

```lisp
(js:log "hello from Lisp" 42)                     ; console: hello from Lisp 42
```

## Values across the boundary

A value is converted each time it crosses, in either direction.

| Lisp | JavaScript |
|---|---|
| `T` | `true` |
| `:false` | `false` |
| `NIL`, `:null` | `null` |
| `:undefined` | `undefined` |
| any other keyword | its name in lower case: `:foo` is `"foo"` |
| a real | a number: `1/2` is `0.5` |
| a string, a character | a string |
| a list or a vector | an array of its elements, each converted |
| a function | a function; see [Lisp functions as callbacks](#lisp-functions-as-callbacks) |
| a JavaScript value that came back | itself |
| any other Lisp object | an opaque value that comes back as the same object |

```lisp
(js:call (js:global "JSON") "stringify"
         (js:array t nil :false :null :undefined :foo 1/2 #\x "s" '(1 2) #(3 4)))
;; => "[true,null,false,null,null,\"foo\",0.5,\"x\",\"s\",[1,2],[3,4]]"
```

(`:undefined` prints as `null` there because `JSON.stringify` writes an
undefined element of an array that way.)

Coming back, `true` is `T`; `false`, `null` and `undefined` are `NIL`; a number
with no fraction that is exactly representable is an integer, and any other is
a double; a string is a string. Objects, arrays and functions stay JavaScript's.

```lisp
(let ((a (js:eval "[true, false, null, undefined, 3, 2.5, 'x']")))
  (loop for i below 7 collect (js:get a i)))      ; => (T NIL NIL NIL 3 2.5d0 "x")
```

Since numbers, strings and booleans arrive converted, `js:typeof` of one is
`:lisp`. What stays JavaScript's answers as `typeof` would, and `js:js-value-p`
says whether a value is one:

```lisp
(list (js:typeof (js:global "document"))
      (js:typeof (js:global "parseInt"))
      (js:typeof 1))                              ; => (:OBJECT :FUNCTION :LISP)
(js:js-value-p (js:global "document"))            ; => T
```

An array is held by reference, so changing one that came back changes the
array:

```lisp
(let ((a (js:array 1 2)))
  (js:call a "push" 3)
  (js:get a "length"))                            ; => 3
```

A Lisp object that is not one of the kinds in the table goes out as an opaque
value and comes back as the same object:

```lisp
(let ((h (make-hash-table)))
  (eq h (js:get (js:object "k" h) "k")))          ; => T
```

## Errors

A JavaScript exception thrown by a call signals `js:js-error`, which carries
what was thrown and, for an `Error`, its name and message:

```lisp
(handler-case (js:call (js:global "JSON") "parse" "{")
  (js:js-error (e) (list (js:js-error-name e) (js:js-error-message e))))
;; => ("SyntaxError" "Expected property name or '}' in JSON at position 1 (line 1 column 2)")
```

`js:js-error-value` is the thrown value itself.

## Lisp functions as callbacks

A Lisp function passed to JavaScript becomes a JavaScript function, so it can
be an event listener:

```lisp
(let ((b (js:element "button")))
  (js:set b "textContent" "Click me")
  (js:append (js:body) b)
  (js:call b "addEventListener" "click"
           (lambda (event) (js:log "clicked:" (js:get event "type")))))
```

**In the published playground, a callback runs later, and its value is
dropped.** The playground is built with threads, which the REPL and the editor
page need. In that build, the browser's page thread may not call into .NET
synchronously, and a call that did could not call JavaScript back in turn. So
the JavaScript function returns `undefined` at once, and the Lisp function runs
afterwards on a thread of its own, as a block does. An error in it goes to the
console and does not stop the page.

A listener therefore works. What does not work is a callback whose result
JavaScript uses. That rules out `map` and `sort`, and `preventDefault` called
from a listener, which comes too late:

```lisp
(js:call (js:call (js:array 1 2 3) "map"
                  (lambda (x &rest more) (declare (ignore more)) (* x 10)))
         "join" ",")                              ; => ",," — map saw undefined three times
```

A build without threads runs callbacks synchronously, as clysm does: `map` and
`sort` get each value back, `preventDefault` takes effect, and an error in a
callback reaches the Lisp that made the call. That build cannot run the REPL or the
editor, and the playground does not publish it yet.

## For the pages here

On top of the clysm names, `js:` has a few for working with the document:

```lisp
(js:document)                                     ; document
(js:body)                                         ; document.body
(js:query "h1")                                   ; document.querySelector("h1")
(js:text (js:query "h1"))                         ; => "Common Lisp, running here"
(setf (js:text (js:query "h1")) "Hello")          ; .textContent = "Hello"
(js:element "button")                             ; document.createElement("button")
(js:append (js:body) (js:element "p"))            ; appendChild; returns the child
```

`js:query` takes a root to search under as an optional second argument.

## Where it differs from clysm

- **Callbacks** run asynchronously and their values are dropped, in the threaded
  build. See [above](#lisp-functions-as-callbacks).
- **Not here yet**: `js:await`, `js:async-function`, `js:async`,
  `js:await-all` and `js:can-await-p`; `js:module`, `js:require`, `js:import`
  and `js:export`; `js:to-octets` and `js:from-octets`.
- **`js:to-js`** returns a Lisp value wherever the result converts back, so only
  an array or a function is different afterwards. `js:to-lisp` is the identity,
  since values arrive converted already.
- **The page helpers** (`js:document`, `js:query`, `js:text` and the rest) are
  this playground's own.

## Cost

A call crosses from .NET to the page and back. In the published, threaded
build that is about 95 µs: 4000 `fillStyle` and `fillRect` pairs on a canvas
take about 0.75 s. A build without threads takes about half that. Drawing a
frame a call at a time will not keep up; work that can be batched into one call
should be.

## Where the vocabulary lives

`js:` is ordinary Lisp in [`src/js.lisp`](../src/js.lisp). That file is
served beside the pages and loaded when one starts, so adding a function to it
is editing the file and reloading the page, with no rebuild. It stands on a few
functions in [`src/wwwroot/js-bridge.js`](../src/wwwroot/js-bridge.js) (get,
set, call, apply, construct). The conversion of values is in
[`src/Program.cs`](../src/Program.cs).
