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
