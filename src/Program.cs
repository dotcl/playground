using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;
using DotCL;

/// <summary>
/// The whole .NET side of the playground. The page never calls dotcl directly —
/// it calls Boot once and Run per block, and everything else lives in Lisp
/// (prelude.lisp) or in JavaScript.
/// </summary>
public static partial class Playground
{
    public static void Main() { }

    private static bool _booted;

    /// <summary>Field separator shared with prelude.lisp (ASCII unit separator,
    /// which cannot occur in Lisp source).</summary>
    private static readonly string S = ((char)31).ToString();

    /// <summary>Load the core and the prelude. Returns "ok" or a description of
    /// what went wrong — the page shows it either way rather than failing
    /// silently on a blank screen.</summary>
    [JSExport]
    public static async Task<string> Boot()
    {
        var booted = await Task.Run(BootCore);
        if (booted != "ok") return booted;
        // The bridge comes up with the image rather than on request: a page
        // whose JS: functions fail until something else has been called is a
        // trap, not a feature.
        var bridged = await LoadBridge();
        return bridged == "ok" ? await LoadJsLisp() : bridged;
    }

    private static string BootCore()
    {
        if (_booted) return "ok";
        try
        {
            var asm = Assembly.GetExecutingAssembly();

            // The core arrives as bytes, never as a path: a page has no
            // filesystem to hand the loader.
            using (var s = asm.GetManifestResourceStream("dotcl.core"))
            {
                var ms = new MemoryStream();
                s.CopyTo(ms);
                Startup.Initialize();
                DotclHost.LoadCore(ms.ToArray());
            }

            // Anything else that was embedded — absent unless the build was
            // pointed at it. See ContribModules and ExtraCore in the .csproj.
            //
            // The modules go to the filesystem rather than straight into the
            // image: what needs them is code inside the core calling REQUIRE,
            // which searches for a file. Nothing has to say in advance which
            // ones that will be.
            UnpackContrib(asm, ContribRoot);

            // Likewise a data file some library insists on reading as it loads,
            // at the absolute path it looks for. See MimeTypes in the .csproj.
            UnpackFile(asm, "etc/mime.types", "/etc/mime.types");

            LoadLisp(asm, "prelude.lisp", "/playground-prelude.lisp");

            // Confirm rather than assume: a condition signalled while loading is
            // reported to the console and execution carries on, so a broken
            // prelude would otherwise leave the page claiming to be ready.
            var check = Text(DotclHost.EvalString(
                "(let ((p (find-package \"PLAYGROUND\")))"
                + " (if (and p (fboundp (find-symbol \"RUN\" p))) \"ok\" \"no\"))"));
            if (check != "\"ok\"" && check != "ok")
                return "the prelude did not define PLAYGROUND:RUN (" + check + ")";

            _booted = true;
            return "ok";
        }
        catch (Exception e) { return "boot failed:" + Chain(e); }
    }

    /// <summary>Evaluate one block. The record it returns is assembled in Lisp;
    /// see PLAYGROUND:RUN.</summary>
    [JSExport]
    public static Task<string> Run(string source) => Task.Run(() => RunCore(source));

    private static string RunCore(string source)
    {
        // Text, not the printed representation of a string — ToString would wrap
        // the record in quotes and escape what is inside it, and the field
        // separators would no longer line up.
        try { return Text(DotclHost.EvalString("(playground:run " + Literal(source) + ")")); }
        // Only reached if the Lisp side itself is broken — PLAYGROUND:RUN
        // handles ordinary evaluation errors and reports them as data.
        catch (Exception e) { return "error" + S + S + S + "HOST" + S + Chain(e) + S; }
    }

    /// <summary>Load a save-application closure on top of the base core. The
    /// bytes come from the page, which fetched them: an image big enough to be
    /// worth choosing is too big to sit in an assembly every page downloads.
    /// Returns "ok" or what went wrong.</summary>
    [JSExport]
    public static Task<string> LoadExtraCore(byte[] core) => Task.Run(() =>
    {
        try
        {
            // A closure adds to the base core rather than replacing it, so it
            // loads after — and anything written against it, after that.
            DotclHost.LoadCore(core);
            LoadLisp(Assembly.GetExecutingAssembly(), "lem-page.lisp", "/lem-page.lisp");
            return "ok";
        }
        catch (Exception e) { return "loading the image failed:" + Chain(e); }
    });

    // ── JavaScript ───────────────────────────────────────────────────────────
    //
    // A few imports, the conversion of values across them, and a loader; nothing
    // here knows what a canvas is. The shim they point at is js-bridge.js; the
    // vocabulary on top of them — documents, elements, contexts — is written in
    // Lisp, where it can be added to without rebuilding anything.
    //
    // The wrappers are public and take plain object because that is what Lisp
    // reaches: dotnet:invoke finds a method by name on a public type.

    private const string Bridge = "dotcl-js";
    private static bool _bridgeLoaded;

    /// <summary>Make the shim available. Idempotent; the page calls it once.</summary>
    [JSExport]
    public static async Task<string> LoadBridge()
    {
        if (_bridgeLoaded) return "ok";
        try
        {
            // Relative to _framework/, where the loader lives — not to the page.
            // "./js-bridge.js" looks for it inside _framework/ and fails; a
            // leading slash would work locally and break wherever the site is
            // served under a path, which is where it is served.
            await JSHost.ImportAsync(Bridge, "../js-bridge.js");
            _bridgeLoaded = true;
            return "ok";
        }
        catch (Exception e) { return "the JavaScript bridge did not load:" + Chain(e); }
    }

    /// <summary>Fetch js.lisp from beside the page and load it. It is served
    /// rather than embedded so that the layer meant to be added to can be
    /// edited and reloaded, instead of costing a rebuild per line.</summary>
    private static async Task<string> LoadJsLisp()
    {
        try
        {
            // Where the page is, asked of the browser directly — JSObject can
            // read properties without the bridge, and this runs whether or not
            // the bridge is there. Relative to the document, so it is right
            // both at a site root and under a path.
            var href = JSHost.GlobalThis
                .GetPropertyAsJSObject("location")
                .GetPropertyAsString("href");
            using var http = new System.Net.Http.HttpClient();
            var source = await http.GetStringAsync(new Uri(new Uri(href), "js.lisp"));
            File.WriteAllText("/js.lisp", source);
            DotclHost.EvalString("(load \"/js.lisp\")");
            return "ok";
        }
        catch (Exception e) { return "js.lisp did not load:" + Chain(e); }
    }

    [JSImport("undefinedMarker", Bridge)]
    internal static partial JSObject BridgeUndefined();

    [JSImport("lastThrown", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeLastThrown();

    [JSImport("nameOf", Bridge)]
    internal static partial string BridgeNameOf([JSMarshalAs<JSType.Any>] object e);

    [JSImport("messageOf", Bridge)]
    internal static partial string BridgeMessageOf([JSMarshalAs<JSType.Any>] object e);

    [JSImport("get", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeGet([JSMarshalAs<JSType.Any>] object target,
        [JSMarshalAs<JSType.Any>] object key);

    [JSImport("set", Bridge)]
    internal static partial void BridgeSet([JSMarshalAs<JSType.Any>] object target,
        [JSMarshalAs<JSType.Any>] object key, [JSMarshalAs<JSType.Any>] object value);

    [JSImport("call", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeCall([JSMarshalAs<JSType.Any>] object target,
        [JSMarshalAs<JSType.Any>] object key,
        [JSMarshalAs<JSType.Array<JSType.Any>>] object[] args);

    [JSImport("apply", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeApply([JSMarshalAs<JSType.Any>] object function,
        [JSMarshalAs<JSType.Array<JSType.Any>>] object[] args);

    [JSImport("construct", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeConstruct([JSMarshalAs<JSType.Any>] object constructor,
        [JSMarshalAs<JSType.Array<JSType.Any>>] object[] args);

    [JSImport("array", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeArray([JSMarshalAs<JSType.Array<JSType.Any>>] object[] items);

    [JSImport("typeOf", Bridge)]
    internal static partial string BridgeTypeOf([JSMarshalAs<JSType.Any>] object x);

    [JSImport("wrap", Bridge)]
    [return: JSMarshalAs<JSType.Any>]
    internal static partial object BridgeWrap(int id);

    // What the values are on each side, the same as clysm's JS package, so that
    // code written against one reads the same against the other. Going out: NIL
    // and :NULL are null, T true, :FALSE false, :UNDEFINED undefined, another
    // keyword its name in lower case, a real a number, a character a string, a
    // sequence an array of its elements, a function a function. Coming back: null
    // and undefined are NIL, a boolean T or NIL, a number with no fraction (and
    // exactly representable) an integer, a string a string. Objects and functions
    // stay JavaScript's, and a Lisp object that went out comes back as itself.
    //
    // The parameters are object rather than LispObject: dotcl hands a wrapped
    // .NET object, a JSObject among them, to an object parameter as itself, and
    // would try to convert it to a LispObject one. What reaches here is either a
    // value dotcl has already made .NET's (null, a long, a string) or a Lisp
    // object it left alone (T, a keyword, a cons, a function).

    private static object ToJs(object x) => x switch
    {
        null or bool or string or double or JSObject => x,
        long l => (double)l,
        int i => (double)i,
        float f => (double)f,
        char c => c.ToString(),
        System.Numerics.BigInteger b => (double)b,
        LispObject lisp => LispToJs(lisp),
        _ => x,
    };

    private static object LispToJs(LispObject x) => x switch
    {
        Nil => null,
        T => true,
        Symbol { HomePackage.Name: "KEYWORD" } s => s.Name switch
        {
            "FALSE" => false,
            "NULL" => null,
            "UNDEFINED" => BridgeUndefined(),
            _ => s.Name.ToLowerInvariant(),
        },
        Fixnum f => (double)f.Value,
        DoubleFloat d => d.Value,
        SingleFloat f => (double)f.Value,
        Number n => ((DoubleFloat)DotclHost.Call("FLOAT", n, new DoubleFloat(1.0))).Value,
        LispString s => s.Value,
        LispChar c => c.Value.ToString(),
        LispVector v when v.IsCharVector => v.ToCharString(),
        LispVector v => BridgeArray(Elements(v)),
        Cons c => BridgeArray(Arguments(c)),
        LispFunction f => Wrap(f),
        LispDotNetObject o => ToJs(o.Value),
        _ => x,
    };

    private static object[] Elements(LispVector v)
    {
        var items = new object[v.Length];
        for (var i = 0; i < items.Length; i++) items[i] = LispToJs(v[i]);
        return items;
    }

    /// <summary>A Lisp list as the arguments of a call. NIL arrives as null.</summary>
    private static object[] Arguments(object list)
    {
        var items = new System.Collections.Generic.List<object>();
        for (var l = list as Cons; l != null; l = l.Cdr as Cons) items.Add(LispToJs(l.Car));
        return items.ToArray();
    }

    private static LispObject ToLisp(object o) => o switch
    {
        null => Nil.Instance,
        bool b => b ? T.Instance : Nil.Instance,
        double d when Math.Floor(d) == d && Math.Abs(d) < 9007199254740992.0 => Fixnum.Make((long)d),
        double d => new DoubleFloat(d),
        int i => Fixnum.Make(i),
        long l => Fixnum.Make(l),
        string s => new LispString(s),
        LispObject lisp => lisp,
        _ => new LispDotNetObject(o),
    };

    // A Lisp function as a JavaScript one, which an event can call. The page
    // thread may not call into C# synchronously in the threaded build, and a
    // call it made could not call JavaScript back in turn, so the function the
    // page gets hands its arguments to JsDeliver and returns at once; the Lisp
    // runs on a thread of its own, as a block does. What it returns is dropped.
    // Functions are kept for as long as the page lives: nothing says when
    // JavaScript has let go of one.

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<int, LispFunction>
        _callbacks = new();
    private static int _lastCallback;

    private static object Wrap(LispFunction f)
    {
        var id = System.Threading.Interlocked.Increment(ref _lastCallback);
        _callbacks[id] = f;
        return BridgeWrap(id);
    }

    [JSExport]
    public static Task JsDeliver(int id, JSObject args) => Task.Run(() =>
    {
        try
        {
            var n = (int)(double)BridgeGet(args, "length");
            var lisp = new LispObject[n];
            for (var i = 0; i < n; i++) lisp[i] = ToLisp(BridgeGet(args, (double)i));
            Runtime.Funcall(_callbacks[id], lisp);
        }
        catch (Exception e) { Console.Error.WriteLine("a Lisp callback failed:" + Chain(e)); }
    });

    // A JavaScript exception does not cross as itself: what the marshaller hands
    // over is a JSException with a message and nothing else. js-bridge.js keeps
    // what was thrown, and the call returns Failure — one object, compared by
    // identity, so a value never mistakes for it — for js.lisp to ask about and
    // signal JS:JS-ERROR with. Signalling from here would have meant a Lisp error
    // crossing back out through the host's entry points.

    private static readonly LispObject Failure = new LispString("a JavaScript exception");

    [ThreadStatic] private static object _thrown;

    private static LispObject Js(Func<object> f)
    {
        try { return ToLisp(f()); }
        catch (JSException) { _thrown = BridgeLastThrown(); return Failure; }
    }

    public static LispObject JsFailure() => Failure;
    public static LispObject JsThrown() => ToLisp(_thrown);
    public static string JsThrownName() => _thrown == null ? null : BridgeNameOf(_thrown);
    public static string JsThrownMessage() => BridgeMessageOf(_thrown);

    /// <summary>globalThis — where reaching anything else starts.</summary>
    public static LispObject JsGlobal() => new LispDotNetObject(JSHost.GlobalThis);

    public static LispObject JsGet(object target, object key)
        => Js(() => BridgeGet(ToJs(target), ToJs(key)));

    public static LispObject JsSet(object target, object key, object value)
        => Js(() => { BridgeSet(ToJs(target), ToJs(key), ToJs(value)); return null; });

    public static LispObject JsCall(object target, object key, object args)
        => Js(() => BridgeCall(ToJs(target), ToJs(key), Arguments(args)));

    public static LispObject JsFuncall(object function, object args)
        => Js(() => BridgeApply(ToJs(function), Arguments(args)));

    public static LispObject JsNew(object constructor, object args)
        => Js(() => BridgeConstruct(ToJs(constructor), Arguments(args)));

    public static LispObject JsToJs(object x) => ToLisp(ToJs(x));

    public static bool JsValueP(object x) => x is JSObject;

    public static string JsTypeOf(object x) => x is JSObject ? BridgeTypeOf(x) : "lisp";

    // ── the editor ───────────────────────────────────────────────────────────
    //
    // Three calls, and what they do is in lem-page.lisp. The drawing is pulled
    // rather than pushed because the editor runs on its own thread, and a
    // thread that is not the page thread cannot call into JavaScript.

    /// <summary>Start the editor at this size. "ok", or why not — including the
    /// ordinary case of a build that has no editor in it. lem.html is deployed
    /// with the rest of wwwroot whether or not the image can answer it, so that
    /// has to read as a plain answer rather than as a failure.</summary>
    [JSExport]
    public static Task<string> LemStart(int width, int height) => Task.Run(() =>
        Text(DotclHost.EvalString("(if (find-package \"LEM-PAGE\") \"yes\" \"no\")")) == "yes"
            ? Text(DotclHost.EvalString($"(lem-page:start {width} {height})"))
            : "this build has no editor in it — publish with -p:ExtraCore=… -p:LemPage=true"
              + " (see the README)");

    /// <summary>Everything the editor has drawn since the last call: JSON-RPC
    /// messages joined by the field separator.</summary>
    [JSExport]
    public static Task<string> LemDrain()
        => Task.Run(() => Text(DotclHost.EvalString("(lem-page:drain)")));

    /// <summary>Hand one JSON-RPC message to the editor.</summary>
    [JSExport]
    public static Task LemSend(string json)
        => Task.Run(() => DotclHost.EvalString(
            "(lem-page:deliver-message " + Literal(json) + ")"));

    // ── the REPL ─────────────────────────────────────────────────────────────
    //
    // dotcl-repl with an xterm in the page for a terminal; repl-page.lisp says
    // how it is wired. Keys go from the page into a queue the REPL's thread
    // waits on; what the REPL writes collects here until the page takes it.
    // Both sides are here so that neither the page nor the Lisp has to know
    // which thread the other is on.

    private static readonly System.Collections.Concurrent.BlockingCollection<ConsoleKeyInfo> _keys = new();
    private static readonly System.Text.StringBuilder _screen = new();
    private static volatile int _cols = 80, _rows = 24;

    /// <summary>Start the REPL at this size. "ok", or why not.</summary>
    [JSExport]
    public static Task<string> ReplStart(int cols, int rows) => Task.Run(() =>
    {
        _cols = cols; _rows = rows;
        try
        {
            LoadLisp(Assembly.GetExecutingAssembly(), "repl-page.lisp", "/repl-page.lisp");
            return Text(DotclHost.EvalString("(repl-page:start)"));
        }
        catch (Exception e) { return "the REPL did not start:" + Chain(e); }
    });

    /// <summary>One key, as Console.ReadKey would have returned it. The page
    /// has already turned the browser's key event into these terms.</summary>
    [JSExport]
    public static Task ReplKey(int ch, int key, bool shift, bool alt, bool control)
    {
        _keys.Add(new ConsoleKeyInfo((char)ch, (ConsoleKey)key, shift, alt, control));
        return Task.CompletedTask;
    }

    /// <summary>Everything the REPL has written since the last call.</summary>
    [JSExport]
    public static Task<string> ReplDrain()
    {
        lock (_screen)
        {
            var s = _screen.ToString();
            _screen.Clear();
            return Task.FromResult(s);
        }
    }

    [JSExport]
    public static Task ReplResize(int cols, int rows)
    {
        _cols = cols; _rows = rows;
        return Task.CompletedTask;
    }

    /// <summary>One contrib module the page fetched, as name.fasl and its bytes,
    /// written where REQUIRE will find it. Before ReplStart, which REQUIREs
    /// them.</summary>
    [JSExport]
    public static Task<string> ReplAddContrib(string file, byte[] fasl) => Task.Run(() =>
    {
        try { WriteContrib(ContribRoot, file, new MemoryStream(fasl)); return "ok"; }
        catch (Exception e) { return "could not add " + file + ":" + Chain(e); }
    });

    /// <summary>Interrupt the form being evaluated, as Ctrl+C does at a
    /// console. "t", or "nil" when nothing was being evaluated — the REPL was
    /// waiting for a key, and Ctrl+C should go to it as a key instead.</summary>
    [JSExport]
    public static Task<string> ReplInterrupt() => Task.Run(() =>
        Text(DotclHost.EvalString("(if (dotcl-repl:interrupt-repl) \"t\" \"nil\")")));

    // The terminal's side, called from repl-page.lisp on the REPL's thread.
    public static ConsoleKeyInfo ReplReadKey() => _keys.Take();
    public static bool ReplKeyAvailable() => _keys.Count > 0;
    public static void ReplWrite(string s) { lock (_screen) _screen.Append(s); }
    public static int ReplWidth() => _cols;
    public static int ReplHeight() => _rows;

    /// <summary>Load an embedded Lisp file through the filesystem, if it is
    /// there. Through a file rather than as one string because these define a
    /// package and then read symbols in it: the reader must not run ahead of
    /// the evaluator, which is exactly what LOAD guarantees and what wrapping
    /// the file in a single PROGN would break. A browser does have a
    /// filesystem — an in-memory one, empty until written to.</summary>
    private static void LoadLisp(Assembly asm, string resource, string path)
    {
        using var s = asm.GetManifestResourceStream(resource);
        if (s == null) return;
        using (var r = new StreamReader(s)) File.WriteAllText(path, r.ReadToEnd());
        DotclHost.EvalString("(load \"" + path + "\")");
    }

    /// <summary>Where the embedded contrib modules are written. Any directory
    /// will do — dotcl is told about it rather than having to guess.</summary>
    private const string ContribRoot = "/dotcl-contrib";

    /// <summary>Write the embedded contrib modules to the in-memory filesystem
    /// as contrib/name/name.fasl, and point dotcl's module search at them.
    /// Does nothing when none were embedded.</summary>
    private static void UnpackContrib(Assembly asm, string root)
    {
        foreach (var resource in asm.GetManifestResourceNames())
        {
            if (!resource.StartsWith("contrib/")) continue;
            using var s = asm.GetManifestResourceStream(resource);
            WriteContrib(root, resource.Substring("contrib/".Length), s);
        }
    }

    /// <summary>Write one module as root/name/name.fasl, and point dotcl's
    /// module search at root the first time.</summary>
    private static void WriteContrib(string root, string file, Stream s)
    {
        var dir = Path.Combine(root, Path.GetFileNameWithoutExtension(file));
        Directory.CreateDirectory(dir);
        using (var f = File.Create(Path.Combine(dir, file)))
            s.CopyTo(f);
        lock (Runtime.ContribExtraSearchPaths)
            if (!Runtime.ContribExtraSearchPaths.Contains(root))
                Runtime.ContribExtraSearchPaths.Add(root);
    }

    /// <summary>Write one embedded file to the in-memory filesystem, if it was
    /// embedded at all.</summary>
    private static void UnpackFile(Assembly asm, string resource, string path)
    {
        using var s = asm.GetManifestResourceStream(resource);
        if (s == null) return;
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        using var f = File.Create(path);
        s.CopyTo(f);
    }

    /// <summary>The characters of a Lisp string, without the reader syntax.</summary>
    private static string Text(LispObject o)
        => o is LispString s ? s.Value : o?.ToString() ?? "";

    /// <summary>SOURCE as a Lisp string literal. Only " and \ need escaping;
    /// newlines are legal inside a Lisp string.</summary>
    private static string Literal(string source)
    {
        var sb = new System.Text.StringBuilder(source.Length + 2);
        sb.Append('"');
        foreach (var c in source)
        {
            if (c == '"' || c == '\\') sb.Append('\\');
            sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    private static string Chain(Exception e)
    {
        var sb = new System.Text.StringBuilder();
        for (var x = e; x != null; x = x.InnerException)
            sb.Append(sb.Length == 0 ? "" : " | ").Append(x.GetType().Name).Append(": ").Append(x.Message);
        return sb.ToString();
    }
}
