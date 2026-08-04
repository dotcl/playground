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
    public static Task<string> Boot() => Task.Run(BootCore);

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
            // pointed at it. See ContribModules and LemCore in the .csproj.
            //
            // The modules go to the filesystem rather than straight into the
            // image: what needs them is code inside the core calling REQUIRE,
            // which searches for a file. Nothing has to say in advance which
            // ones that will be.
            UnpackContrib(asm, ContribRoot);

            // Likewise a data file some library insists on reading as it loads,
            // at the absolute path it looks for. See MimeTypes in the .csproj.
            UnpackFile(asm, "etc/mime.types", "/etc/mime.types");

            // A save-application closure, which adds to the base core rather
            // than replacing it — so it loads after, not instead.
            LoadEmbedded(asm, "lem.core");

            // Through the filesystem rather than as one string: the prelude
            // defines a package and then reads symbols in it, so the reader must
            // not run ahead of the evaluator. LOAD gets that right by definition,
            // and wrapping the file in a single PROGN gets it wrong. A browser
            // does have a filesystem — an in-memory one, empty until written to.
            const string preludePath = "/playground-prelude.lisp";
            using (var s = asm.GetManifestResourceStream("prelude.lisp"))
            using (var r = new StreamReader(s))
                File.WriteAllText(preludePath, r.ReadToEnd());
            DotclHost.EvalString("(load \"" + preludePath + "\")");

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

    /// <summary>Where the embedded contrib modules are written. Any directory
    /// will do — dotcl is told about it rather than having to guess.</summary>
    private const string ContribRoot = "/dotcl-contrib";

    /// <summary>Write the embedded contrib modules to the in-memory filesystem
    /// as contrib/name/name.fasl, and point dotcl's module search at them.
    /// Does nothing when none were embedded.</summary>
    private static void UnpackContrib(Assembly asm, string root)
    {
        var any = false;
        foreach (var resource in asm.GetManifestResourceNames())
        {
            if (!resource.StartsWith("contrib/")) continue;
            var file = resource.Substring("contrib/".Length);
            var dir = Path.Combine(root, Path.GetFileNameWithoutExtension(file));
            Directory.CreateDirectory(dir);
            using (var s = asm.GetManifestResourceStream(resource))
            using (var f = File.Create(Path.Combine(dir, file)))
                s.CopyTo(f);
            any = true;
        }
        if (any) Runtime.ContribExtraSearchPaths.Add(root);
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

    /// <summary>Load an embedded core or module, if it is there. Absent is the
    /// normal case: these are opt-in at build time.</summary>
    private static void LoadEmbedded(Assembly asm, string name)
    {
        using var s = asm.GetManifestResourceStream(name);
        if (s == null) return;
        var ms = new MemoryStream();
        s.CopyTo(ms);
        DotclHost.LoadCore(ms.ToArray());
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
