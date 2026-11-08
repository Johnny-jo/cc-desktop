using System;
using System.Drawing;
using AgentOS.Computer;

// Synthetic BGR pixels. No desktop session, graphics device, or window handles are involved.
internal static class CaptureSourceTests
{
    static readonly Size Size = new Size(2, 1);
    static readonly byte[] Flat = { 4, 9, 13, 4, 9, 13 };
    static readonly byte[] Detail = { 4, 9, 13, 4, 8, 13 };
    static readonly byte[] Composite = { 3, 2, 1, 6, 5, 4 };

    static void Verify(string requested, byte[] print, string expected, byte[] wanted, string order)
    {
        string calls = "";
        var image = VisualDesktop.ReadSource(ref requested, Size,
            delegate { calls += "P"; return print; },
            delegate { calls += "C"; return Composite; });
        if (requested != expected || image != wanted || calls != order)
            throw new Exception("Expected " + expected + " via " + order + ", got " + requested + " via " + calls);
    }

    // Absolute physical pixels on a secondary monitor and a window crop with a nonzero origin.
    static readonly Rectangle Crop = new Rectangle(-330, 143, 160, 106);
    static readonly Rectangle Label = new Rectangle(-300, 182, 86, 28);
    static readonly Point Click = new Point(-257, 196);

    static void Draw(byte[] image, int x, int y, int width, int height, byte color)
    {
        for (int row = y; row < y + height; row++)
            for (int col = x; col < x + width; col++)
                image[((row - Crop.Y) * Crop.Width + col - Crop.X) * 3] = color;
    }

    static void Recheck(byte[] observed, byte[] current, Rectangle? label)
    {
        var patch = VisualDesktop.ClickPatch(observed, Crop, Click, label);
        if (!Crop.Contains(patch) || !patch.Contains(Click)) throw new Exception("Patch escaped the crop or missed the click.");
        var now = new byte[patch.Width * patch.Height * 3];
        for (int row = 0; row < patch.Height; row++)
            Buffer.BlockCopy(current, ((patch.Y - Crop.Y + row) * Crop.Width + patch.X - Crop.X) * 3,
                now, row * patch.Width * 3, patch.Width * 3);
        VisualDesktop.ComparePatch(observed, Crop, patch, now);
    }

    static void MustRefuse(Action check, string reason)
    {
        try { check(); }
        catch (InvalidOperationException) { return; }
        throw new Exception("Expected a fresh observation for " + reason);
    }

    static void VerifyClickPatches()
    {
        var observed = new byte[Crop.Width * Crop.Height * 3];
        // Four separate glyphs across the label and a live seconds display just above it.
        for (int i = 0; i < 4; i++)
        {
            int x = Label.Left + 3 + i * 21;
            Draw(observed, x, Label.Top + 4, 3, 19, 220);
            Draw(observed, x, Label.Top + 4, 16, 3, 220);
        }
        Draw(observed, Click.X, Label.Top - 12, 3, 4, 150);
        var next = (byte[])observed.Clone();
        Draw(next, Click.X, Label.Top - 12, 3, 4, 190);
        Recheck(observed, next, Label);
        MustRefuse(delegate { Recheck(observed, next, null); }, "an unlabelled click in changing context");

        // The last character changes while the central glyphs and the counter stay the same.
        next = (byte[])observed.Clone();
        Draw(next, Label.Right - 6, Label.Top + 5, 1, 1, 0);
        MustRefuse(delegate { Recheck(observed, next, Label); }, "a changed final glyph");
        next = (byte[])observed.Clone();
        Draw(next, Label.Left, Label.Top, Label.Width, Label.Height, 64);
        MustRefuse(delegate { Recheck(observed, next, Label); }, "a solid repaint over the label");
        var shifted = (byte[])observed.Clone();
        for (int y = Label.Top; y < Label.Bottom; y++)
        {
            int start = ((y - Crop.Y) * Crop.Width + Label.Left - Crop.X) * 3;
            Buffer.BlockCopy(observed, start, shifted, start + 3, Label.Width * 3);
        }
        MustRefuse(delegate { Recheck(observed, shifted, Label); }, "a one-pixel movement");

        var blank = new byte[observed.Length];
        MustRefuse(delegate { Recheck(blank, blank, null); }, "an entirely featureless observation");
        Draw(blank, Click.X, Label.Top - 12, 3, 4, 150);
        MustRefuse(delegate { Recheck(blank, blank, Label); }, "a featureless OCR label next to real detail");
        Draw(blank, Click.X, Click.Y, 1, 1, 220);
        MustRefuse(delegate { Recheck(blank, blank, Label); }, "a single stray pixel inside a featureless label");
        Draw(blank, Label.Left, Click.Y, Label.Width, 2, 220);
        MustRefuse(delegate { Recheck(blank, blank, Label); }, "a straight boundary crossing the alleged label");
        var offPoint = new Rectangle(Label.X, Label.Y, 4, Label.Height);
        MustRefuse(delegate { Recheck(observed, observed, offPoint); }, "label bounds missing the click");
        var outside = new Rectangle(Crop.Left - 1, Label.Y, Crop.Width, Label.Height);
        MustRefuse(delegate { Recheck(observed, observed, outside); }, "label bounds outside the retained observation");
    }

    static void Run()
    {
        VerifyClickPatches();
        Verify("auto", null, "compositor", Composite, "PC");    // PrintWindow returned FALSE.
        Verify("auto", Flat, "compositor", Composite, "PC");
        Verify("auto", Detail, "print", Detail, "P");
        Verify("compositor", Detail, "compositor", Composite, "C");
        Verify("print", Flat, "print", Flat, "P");              // Re-check the changed pixels verbatim.
        string source = "print";
        try
        {
            VisualDesktop.ReadSource(ref source, Size, delegate { return null; },
                delegate { throw new Exception("A print observation switched to the compositor during validation."); });
        }
        catch (InvalidOperationException) { return; }
        throw new Exception("A failed print unexpectedly validated a print observation.");
    }

    static int Main()
    {
        try { Run(); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
