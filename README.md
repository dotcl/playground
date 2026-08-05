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
| `src/trimmer-roots.xml` | .NET types the Lisp reaches by name, which the trimmer cannot see |
| `src/wwwroot/lem.html`, `lem.js` | a second page: Lem, drawn from the messages it sends |
| `src/lem-page.lisp` | the editor's side of that — start it, take its drawing, hand it input |
| `tools/probe-page.mjs`, `probe-lem.mjs` | open either page in headless Chrome and report what it did |
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

**Threads change where the Lisp runs, and it is worth it.** Built plainly, dotcl
runs on the page thread and a block that never returns takes the tab with it. Built
with `-p:WasmEnableThreads=true` it runs off the page thread instead: measured in
Chrome, a twenty-million-iteration loop left `requestAnimationFrame` at a full 60fps
and page callbacks answering in 1-2ms. `dotcl:make-thread` works there too.

The cost is hosting. Threads need `SharedArrayBuffer`, which needs two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

GitHub Pages cannot send headers, so the workflow here builds the single-threaded
page. A host that can send them (Netlify, Cloudflare Pages, anything of your own)
gets the responsive one from the same source — add `-p:WasmEnableThreads=true`.

Running in a dedicated worker instead would have avoided the headers, but does not
work at all: `dotnet.create()` never settles there, because a worker has no
`document`.

**The prelude is loaded with `LOAD`, not evaluated as one form.** It defines a
package and then reads symbols in it, which only works if the reader does not run
ahead of the evaluator. A browser does have a filesystem — an in-memory one,
empty until something writes to it — so the prelude is written there and loaded.

**A bigger image can be loaded, but it has to bring its world with it.** The build
takes three optional inputs, all off by default, for putting a `save-application`
core into the page on top of the one vendored here:

```sh
dotnet publish -c Release \
  -p:ExtraCore=../../lem-dotcl-probe/lem-app.core \
  -p:ContribModules='../../dotcl/contrib/*/*.fasl' \
  -p:MimeTypes=.../trivial-mimes/mime.types
```

Nothing here is about Lem. `ExtraCore` is whatever `save-application` produced,
and Lem is only the largest thing that has been put through it — a closure of a
few libraries is the same mechanism at a fraction of the weight, and stays on
the side of this that GitHub Pages can serve.

The last two are there because a page starts with an *empty* filesystem, not
because of anything about the core. Code inside it calls `REQUIRE`, which looks
for `contrib/name/name.fasl` on disk, and libraries read data files as they load
— `trivial-mimes` signals an error unless `/etc/mime.types` exists. Both are
written to the in-memory filesystem before the core loads. Types the Lisp asks
for *by name* need rooting in `trimmer-roots.xml`, for the same reason
`Playground.csproj` roots assemblies: `trivial-features` decides which OS it is
on by reading `OSPlatform` members, and the trimmer sees no IL referring to them.

Measured with Lem in the core: a 47 MB main assembly, about 20 seconds from
opening the page to a usable image, after which `lem:make-buffer` and the rest
behave as they do on the desktop.

**`lem.html` is that image with a screen attached** — built with `-p:LemPage=true`
alongside the core, since the file it adds names Lem's packages as it is read and
would stop any other image from booting. Lem's own frontend is a
separate program that talks to the editor over a socket; here the editor is a
thread of this runtime, so the transport is jsonrpc's in-process one and the
frontend is `lem.js` — a character grid built from the `put`, `clear` and
`move-cursor` messages the editor already sends. Nothing about the editor is
modified for the page.

It needs `-p:WasmEnableThreads=true`, and that is not a preference: the editor
takes a thread of its own and blocks it, so a single-threaded build cannot start
it at all. Threads need `SharedArrayBuffer`, which needs the two headers in the
section above, so the Lem page needs a host that can send them and the
playground does not. GitHub Pages cannot. The known way around that is a service
worker synthesizing the headers in the browser — what the server sent stops
mattering once the response the page sees comes from the worker — at the cost of
one automatic reload on a first visit. Untested here.

`lem.html` is deployed with the rest of `wwwroot` whether or not the image can
answer it, and says so rather than failing obscurely when it cannot.

What works: typing, movement and editing commands, the modeline, `C-x C-f` and
its prompt window. What does not: **opening an existing file**. Lem detects a
file's encoding through `inquisitor`, whose encoding table gives `:impl-name` a
value per implementation — `#+sbcl`, `#+ccl`, `#+clisp` and so on — and dotcl is
none of them, so every one of its 35 entries ends with a key and no value.
`getf` on an odd-length plist is an error, and it is signalled before any file
content is read. Nothing to do with the browser: the feature test would fail the
same way on the desktop. A fork with a `#+dotcl` branch is the fix.

**A successful publish says nothing about whether the page runs.** The trimmer
removes what only Lisp calls, a core that fails to load fails in the browser and
nowhere else, and neither shows up in the build log. `tools/` opens the pages in
headless Chrome and says what actually happened:

```sh
node tools/probe-page.mjs http://127.0.0.1:8080/ '(lisp-implementation-type)'
node tools/probe-lem.mjs  http://127.0.0.1:8080/lem.html shot.png 'hello|C-a|>>> '
```

Both take `EVAL_AFTER` — Lisp evaluated in the page once it is up, through the
`window.lem` hook — which is how to ask the image questions the screen cannot
answer: which buffers exist, which threads are alive, whether some library
works at all. `probe-lem.mjs` also takes `EVAL_BEFORE`, which runs in the same
image the editor is in and can therefore define a command and then drive it from
the keyboard.

## Limits

Real ones, worth knowing before you plan a chapter around something:

- no sockets, no subprocesses, no native FFI
- no threads on GitHub Pages (they need headers Pages cannot set; elsewhere they work)
- Quicklisp does not work in the page; the image is what you get
- about three to five times slower than the same code on the desktop
- roughly 3.5 MB to download the first time, then cached
