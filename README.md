# dotcl playground

A page that teaches Common Lisp by letting you run it. Every code block on the
page is editable and evaluable, in the browser, with nothing installed.

It runs [dotcl](https://github.com/dotcl/dotcl) — a Common Lisp implementation on
.NET — compiled to WebAssembly. Not a subset: 21932 of the 21937 tests in the ANSI
test suite pass, so the page can teach what the standard says without footnotes
about what this particular implementation left out.

## How it is put together

| | |
|---|---|
| `src/wwwroot/index.html` | the material. Prose plus `<pre class="lisp">` blocks |
| `src/wwwroot/main.js` | turns those blocks into editors with a Run button |
| `src/prelude.lisp` | `PLAYGROUND:RUN` — reads, evaluates, and reports back |
| `src/Program.cs` | boots the Lisp core and hands blocks to it |
| `assets/dotcl.core` | the Lisp image, built by dotcl and vendored here |

**Writing a chapter takes no JavaScript.** Add a `<pre class="lisp">` and it becomes
runnable. Add `data-standalone` to a block that should not drag the blocks above it
along with it.

Blocks share one image, deliberately: a tutorial wants a later chapter to use what
an earlier one defined. A reader who follows a link into the middle of the page has
run nothing above, so opening a block runs the earlier ones first.

## Building

With a dotcl checkout next door (`../dotcl`), the source tree is used, which is how
to test unreleased runtime changes:

```sh
cd src
dotnet publish -c Release
```

Without one, the published `DotCL.Runtime` package is used instead. Either way the
output is a directory of static files:

```
src/bin/Release/net10.0/browser-wasm/AppBundle/
```

Serve it over HTTP — `file://` will not do, WebAssembly needs real responses.

Prerequisites: .NET 10 SDK and the WebAssembly workloads.

```sh
dotnet workload install wasm-tools wasm-experimental
```

## Things worth knowing before changing it

**The trimmer will delete code that only Lisp calls.** Publishing for WebAssembly
runs the trimmer, and a Lisp image is IL loaded at run time — the trimmer cannot
see any of the calls it makes. Anything reachable only from Lisp has to be rooted
in `Playground.csproj`. Turning trimming off is not the way out; the bundle then
mixes in framework assemblies that were not built for `browser-wasm` and fails at
startup instead.

**The Lisp runs on the page's thread.** It was meant to run in a worker, so a
runaway block could be killed and the tab kept alive. `dotnet.create()` does not
settle inside a dedicated worker — there is no `document` there — so for now a
block that never returns takes the tab with it, and the way out is to reload.
Everything around `evaluate()` in `main.js` is already async so that this can move
without disturbing the rest.

**The prelude is loaded with `LOAD`, not evaluated as one form.** It defines a
package and then reads symbols in it, which only works if the reader does not run
ahead of the evaluator. A browser does have a filesystem — an in-memory one,
empty until something writes to it — so the prelude is written there and loaded.

## Limits

Real ones, worth knowing before you plan a chapter around something:

- no sockets, no subprocesses, no native FFI
- no threads (that needs headers GitHub Pages cannot set)
- Quicklisp does not work in the page; the image is what you get
- about three to five times slower than the same code on the desktop
- roughly 3.5 MB to download the first time, then cached
