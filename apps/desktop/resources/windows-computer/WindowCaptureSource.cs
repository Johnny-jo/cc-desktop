using System;
using System.ComponentModel;
using System.Drawing;

namespace AgentOS.Computer
{
    internal sealed partial class VisualDesktop
    {
        // Only the initial observation uses "auto". A later click passes the source it observed.
        internal static byte[] ReadSource(ref string source, Size size, Func<byte[]> print, Func<byte[]> compositor)
        {
            if (source == "compositor") return compositor();
            byte[] image = null;
            try { image = print(); }
            catch (Win32Exception) { if (source != "auto") throw; }
            catch (InvalidOperationException) { if (source != "auto") throw; }
            if (source == "print")
            {
                if (image == null) throw new InvalidOperationException("PrintWindow did not render the target window. Capture it again.");
                return image;
            }
            if (image != null && !IsUniform(image, size.Width, new Rectangle(Point.Empty, size)))
            {
                source = "print";
                return image;
            }
            image = compositor();
            source = "compositor";
            return image;
        }

        private static bool IsUniform(byte[] image, int width, Rectangle area)
        {
            int first = (area.Y * width + area.X) * 3;
            for (int y = 0; y < area.Height; y++)
            {
                int row = first + y * width * 3;
                for (int i = row; i < row + area.Width * 3; i += 3)
                    if (image[i] != image[first] || image[i + 1] != image[first + 1] || image[i + 2] != image[first + 2])
                        return false;
            }
            return true;
        }

        // Require strokes in both directions before using an OCR box. A uniform fill, straight
        // border, or isolated bad pixel cannot identify a label. Recaptured pixels still match exactly.
        private static bool CrossesStroke(byte[] image, int start, int length, int stride)
        {
            int edges = 0;
            for (int n = 1, i = start + stride; n < length; n++, i += stride)
            {
                if (Math.Abs(image[i] - image[i - stride]) >= 18 ||
                    Math.Abs(image[i + 1] - image[i - stride + 1]) >= 18 ||
                    Math.Abs(image[i + 2] - image[i - stride + 2]) >= 18)
                {
                    if (++edges == 2) return true;
                }
            }
            return false;
        }

        private static bool HasLabelDetail(byte[] image, int width, Rectangle box)
        {
            int rowBytes = width * 3, start = (box.Y * width + box.X) * 3;
            int rows = 0, cols = 0;
            for (int y = 0; y < box.Height && rows < 2; y++)
                if (CrossesStroke(image, start + y * rowBytes, box.Width, 3)) rows++;
            if (rows < 2) return false;
            for (int x = 0; x < box.Width && cols < 2; x++)
                if (CrossesStroke(image, start + x * 3, box.Height, rowBytes)) cols++;
            return cols >= 2;
        }

        internal static Rectangle ClickPatch(byte[] pixels, Rectangle region, Point point, Rectangle? targetBounds)
        {
            if (targetBounds.HasValue)
            {
                // Absolute coordinates from the OCR result of this exact observation. Never shrink a
                // label to a distinctive center fragment: any changed glyph must invalidate the click.
                var box = targetBounds.Value;
                if (box.Width < 4 || box.Height < 4 || box.X < region.X || box.Y < region.Y ||
                    (long)box.X + box.Width > region.Right || (long)box.Y + box.Height > region.Bottom ||
                    !box.Contains(point))
                    throw new InvalidOperationException("The text target does not fit this observation. Capture the target again.");
                var relative = new Rectangle(box.X - region.X, box.Y - region.Y, box.Width, box.Height);
                if (!HasLabelDetail(pixels, region.Width, relative))
                    throw new InvalidOperationException("The observed text target lacks distinct pixels. Capture the target again.");
                int margin = Math.Max(2, Math.Min(6, box.Height / 6));
                box.Inflate(margin, margin);
                return Rectangle.Intersect(region, box);
            }

            // Include a boundary even when a high-DPI swatch fills the first patch.
            for (int radius = 48; ; radius *= 2)
            {
                var patch = Rectangle.Intersect(region, new Rectangle(point.X - radius, point.Y - radius,
                    2 * radius + 1, 2 * radius + 1));
                var relative = new Rectangle(patch.X - region.X, patch.Y - region.Y, patch.Width, patch.Height);
                if (!IsUniform(pixels, region.Width, relative)) return patch;
                if (patch == region)
                    throw new InvalidOperationException("The observation contains no distinct pixels. Capture the target again.");
            }
        }

        internal static void ComparePatch(byte[] pixels, Rectangle region, Rectangle patch, byte[] now)
        {
            int rowBytes = patch.Width * 3;
            for (int y = 0; y < patch.Height; y++)
            {
                int cached = ((patch.Y - region.Y + y) * region.Width + patch.X - region.X) * 3;
                for (int i = 0; i < rowBytes; i++)
                    if (pixels[cached + i] != now[y * rowBytes + i])
                    {
                        var error = new InvalidOperationException("Pixels near the target changed before the mouse press. " +
                            "That press was not sent. Inspect the target again.");
                        error.Data["code"] = "observed_pixels_changed";
                        throw error;
                    }
            }
        }
    }
}
