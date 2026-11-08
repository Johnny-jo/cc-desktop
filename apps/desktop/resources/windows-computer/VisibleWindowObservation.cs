using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AgentOS.Computer
{
    internal sealed partial class VisualDesktop
    {
        private string observedDisplay;
        private Rectangle observedDisplayBounds;

        // This explicit screen observation can contain overlapping windows. The input
        // path separately checks the real hit HWND and compares the same screen patch.
        public object CaptureVisibleDisplay(string displayId, string target, IDictionary<string, object> args)
        {
            Clear();
            IntPtr hwnd;
            var bounds = NativeDesktop.CaptureBounds(target, out hwnd);
            var display = displayId == null ? Screen.FromRectangle(bounds) : ResolveDisplay(Screen.AllScreens, displayId);
            var visible = Rectangle.Intersect(display.Bounds, bounds);
            if (visible.Width <= 0 || visible.Height <= 0)
                throw new InvalidOperationException("The target window is outside the selected display. Omit displayId to use its current monitor.");
            // A supplied crop is relative to the display, just like an unbound screen observation.
            var origin = args.ContainsKey("region") ? display.Bounds : visible;
            var crop = OnScreen(origin, ParseRegion(args, origin));
            if (!visible.Contains(crop))
                throw new ArgumentException("The display-relative crop must lie within the target window. Omit region to capture its visible area.");

            observedDisplay = display.DeviceName;
            observedDisplayBounds = display.Bounds;
            var image = ReadScreenPixels(target, bounds, crop);
            if (IsUniform(image, crop.Width, new Rectangle(Point.Empty, crop.Size)))
                throw new InvalidOperationException("This window's screen region is a single color. Bring the target into view or select a region containing its controls.");
            string png = EncodePng(image, crop.Width, crop.Height);
            windowBounds = bounds;
            region = new Rectangle(crop.X - bounds.X, crop.Y - bounds.Y, crop.Width, crop.Height);
            windowId = target;
            pixels = image;
            captureSource = "display";
            observationId = TokenPrefix + Guid.NewGuid().ToString("N");
            return new { windowId = target, displayId = observedDisplay, observationId = observationId, captureSource = captureSource,
                windowBounds = DescribeBounds(bounds), bounds = DescribeBounds(crop), width = crop.Width, height = crop.Height, pngBase64 = png };
        }

        private byte[] ReadVisiblePatch(Rectangle patch)
        {
            return ReadScreenPixels(windowId, windowBounds, OnScreen(windowBounds, patch));
        }

        private void CheckVisibleGeometry(string target, Rectangle bounds, Rectangle screenRegion)
        {
            CheckGeometry(target, bounds);
            if (ResolveDisplay(Screen.AllScreens, observedDisplay).Bounds != observedDisplayBounds ||
                !observedDisplayBounds.Contains(screenRegion) || !bounds.Contains(screenRegion))
                throw new InvalidOperationException("The window or monitor geometry changed. Observe the target again.");
        }

        private byte[] ReadScreenPixels(string target, Rectangle bounds, Rectangle screenRegion)
        {
            CheckVisibleGeometry(target, bounds, screenRegion);
            using (var bitmap = new Bitmap(screenRegion.Width, screenRegion.Height, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(bitmap))
                    graphics.CopyFromScreen(screenRegion.Location, Point.Empty, screenRegion.Size);
                CheckVisibleGeometry(target, bounds, screenRegion);
                var data = bitmap.LockBits(new Rectangle(Point.Empty, bitmap.Size), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    int rowBytes = bitmap.Width * 3;
                    var result = new byte[rowBytes * bitmap.Height];
                    for (int y = 0; y < bitmap.Height; y++)
                        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), result, y * rowBytes, rowBytes);
                    return result;
                }
                finally { bitmap.UnlockBits(data); }
            }
        }
    }
}
