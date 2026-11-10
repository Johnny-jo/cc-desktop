using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AgentOS.Computer
{
    // One bounded, unscaled visual observation per helper, independent of the UIA page cursor.
    internal sealed partial class VisualDesktop
    {
        internal const int MaxPngBytes = 8 * 1024 * 1024;
        private const int MaxRegionPixels = 8 * 1024 * 1024;
        private const int MaxRegionSide = 8192;
        private const int MaxWindowPixels = 36 * 1024 * 1024;
        private const string TokenPrefix = "visual-";

        // The readback requests top-down 32-bit BGRX. The fourth byte is undefined.
        [StructLayout(LayoutKind.Sequential)]
        private struct BitmapInfoHeader
        {
            public uint Size;
            public int Width, Height;
            public ushort Planes, BitCount;
            public uint Compression, SizeImage;
            public int XPelsPerMeter, YPelsPerMeter;
            public uint ClrUsed, ClrImportant;
        }

        [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("user32.dll")] private static extern IntPtr GetWindowDC(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
        [DllImport("gdi32.dll")] private static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint first, uint count,
            [Out] int[] pixels, ref BitmapInfoHeader info, uint usage);
        [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern bool PatBlt(IntPtr dc, int x, int y, int width, int height, uint op);
        [DllImport("gdi32.dll")] private static extern bool GdiFlush();
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);

        private string windowId, observationId, captureSource;
        private Rectangle windowBounds, region;
        private byte[] pixels;

        public static bool IsVisualId(string id) { return id.StartsWith(TokenPrefix, StringComparison.Ordinal); }

        public void Clear()
        {
            pixels = null;
            windowId = observationId = captureSource = null;
        }

        private static int RegionField(IDictionary<string, object> fields, string key)
        {
            object value;
            if (!fields.TryGetValue(key, out value) || !(value is int))
                throw new ArgumentException("region." + key + " must be an integer in physical pixels.");
            return (int)value;
        }

        private static Rectangle ParseRegion(IDictionary<string, object> args, Rectangle bounds)
        {
            var crop = new Rectangle(0, 0, bounds.Width, bounds.Height);
            object value;
            if (args.TryGetValue("region", out value))
            {
                var fields = value as IDictionary<string, object>;
                if (fields == null) throw new ArgumentException("region must have integer x, y, width and height fields.");
                crop = new Rectangle(RegionField(fields, "x"), RegionField(fields, "y"),
                    RegionField(fields, "width"), RegionField(fields, "height"));
                if (crop.X < 0 || crop.Y < 0 || crop.Width <= 0 || crop.Height <= 0 ||
                    (long)crop.X + crop.Width > bounds.Width || (long)crop.Y + crop.Height > bounds.Height)
                    throw new ArgumentException("The region must lie entirely inside the target, relative to its top-left corner.");
            }
            if (crop.Width > MaxRegionSide || crop.Height > MaxRegionSide || (long)crop.Width * crop.Height > MaxRegionPixels)
                throw new ArgumentException("The capture exceeds 8192 pixels per side or 8388608 pixels total. Request a smaller region.");
            return crop;
        }

        private static IntPtr CheckGeometry(string target, Rectangle expected)
        {
            IntPtr hwnd;
            if (NativeDesktop.CaptureBounds(target, out hwnd) != expected)
                throw new InvalidOperationException("The target window moved or resized. Capture it again before using coordinates.");
            return hwnd;
        }

        private static byte[] ReadBitmapRegion(IntPtr dc, IntPtr bitmap, Size size, Rectangle crop)
        {
            var header = new BitmapInfoHeader { Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader)),
                Width = size.Width, Height = -size.Height, Planes = 1, BitCount = 32 };
            var result = new byte[crop.Width * crop.Height * 3];
            int bandHeight = Math.Min(crop.Height, Math.Max(1, (1024 * 1024) / size.Width));
            var band = new int[bandHeight * size.Width]; // Bound temporary readback to four MiB.
            int output = 0;
            for (int y = 0; y < crop.Height; y += bandHeight)
            {
                int count = Math.Min(bandHeight, crop.Height - y);
                // GetDIBits numbers source scans from the bottom of a DDB, even when the output is top-down.
                uint first = (uint)(size.Height - (crop.Y + y + count));
                if (GetDIBits(dc, bitmap, first, (uint)count, band, ref header, 0) != count)
                    throw new InvalidOperationException("Windows could not read all requested rows of the window image.");
                for (int row = 0; row < count; row++)
                {
                    int start = row * size.Width + crop.X;
                    for (int i = start; i < start + crop.Width; i++)
                    {
                        int bgr = band[i];
                        result[output++] = (byte)bgr;
                        result[output++] = (byte)(bgr >> 8);
                        result[output++] = (byte)(bgr >> 16);
                    }
                }
            }
            return result;
        }

        private static byte[] PrintPixels(IntPtr hwnd, Rectangle bounds, Rectangle crop)
        {
            // Some renderers ignore DC viewport offsets. Render the entire HWND, then copy only the requested rows.
            // Use the target's device format for printing (including GPU-backed WPF windows). The window DC
            // is only a format reference. All pixels come from PrintWindow into the private bitmap.
            var windowDC = GetWindowDC(hwnd);
            if (windowDC == IntPtr.Zero) throw new InvalidOperationException("Cannot acquire the target window's device context.");
            IntPtr dc = IntPtr.Zero, bitmap = IntPtr.Zero;
            IntPtr previous = IntPtr.Zero;
            try
            {
                dc = CreateCompatibleDC(windowDC);
                if (dc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot create a window capture context.");
                bitmap = CreateCompatibleBitmap(windowDC, bounds.Width, bounds.Height);
                if (bitmap == IntPtr.Zero)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot allocate pixels for this window.");
                previous = SelectObject(dc, bitmap);
                if (previous == IntPtr.Zero || previous == new IntPtr(-1) ||
                    !PatBlt(dc, 0, 0, bounds.Width, bounds.Height, 0x00000042) || !GdiFlush()) // BLACKNESS
                    throw new InvalidOperationException("Cannot prepare the window capture bitmap.");
                // PW_RENDERFULLCONTENT includes compositor-backed windows that implement window capture.
                if (!PrintWindow(hwnd, dc, 2) || !GdiFlush()) return null;

                // GetDIBits requires the bitmap to be unselected.
                if (SelectObject(dc, previous) != bitmap)
                    throw new InvalidOperationException("Cannot detach the rendered window bitmap for readback.");
                previous = IntPtr.Zero;
                return ReadBitmapRegion(dc, bitmap, bounds.Size, crop);
            }
            finally
            {
                if (previous != IntPtr.Zero && previous != new IntPtr(-1)) SelectObject(dc, previous);
                if (dc != IntPtr.Zero) DeleteDC(dc);
                if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
                ReleaseDC(hwnd, windowDC);
            }
        }

        private static byte[] ReadWindowPixels(string target, Rectangle bounds, Rectangle crop, ref string source)
        {
            if ((long)bounds.Width * bounds.Height > MaxWindowPixels || bounds.Width > 32768 || bounds.Height > 32768)
                throw new InvalidOperationException("The source window exceeds the native render budget. Resize it before capturing it.");
            var hwnd = CheckGeometry(target, bounds);
            var image = ReadSource(ref source, crop.Size, delegate { return PrintPixels(hwnd, bounds, crop); }, delegate
            {
                hwnd = CheckGeometry(target, bounds);
                try { return CompositorCapture.Read(hwnd, bounds, crop); }
                catch (Exception error)
                {
                    throw new InvalidOperationException("Window compositor capture failed (" + error.HResult.ToString("X8") + "): " +
                        error.Message + " Activate the window and use observe_display_visual with the same windowId to inspect its visible pixels.", error);
                }
            });
            CheckGeometry(target, bounds);
            return image;
        }

        private static string EncodePng(byte[] image, int width, int height)
        {
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                try
                {
                    int rowBytes = width * 3;
                    for (int y = 0; y < height; y++)
                        Marshal.Copy(image, y * rowBytes, IntPtr.Add(data.Scan0, y * data.Stride), rowBytes);
                }
                finally { bitmap.UnlockBits(data); }
                return EncodePng(bitmap);
            }
        }

        private static string EncodePng(Bitmap bitmap)
        {
            using (var stream = new MemoryStream())
            {
                bitmap.Save(stream, ImageFormat.Png);
                if (stream.Length > MaxPngBytes)
                    throw new InvalidOperationException("The PNG exceeds 8 MiB. Request a smaller region.");
                return Convert.ToBase64String(stream.GetBuffer(), 0, (int)stream.Length);
            }
        }

        private static Rectangle OnScreen(Rectangle bounds, Rectangle crop)
        {
            return new Rectangle(checked(bounds.X + crop.X), checked(bounds.Y + crop.Y), crop.Width, crop.Height);
        }

        private static object DescribeBounds(Rectangle bounds)
        {
            return new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height };
        }

        private static object[] DescribeDisplays(Screen[] screens)
        {
            return screens.Select(display => (object)new { displayId = display.DeviceName, primary = display.Primary,
                bounds = DescribeBounds(display.Bounds) }).ToArray();
        }

        public static object[] ListDisplays() { return DescribeDisplays(Screen.AllScreens); }

        private static Screen ResolveDisplay(Screen[] screens, string id)
        {
            var selected = id == null ? screens.FirstOrDefault(display => display.Primary) :
                screens.FirstOrDefault(display => String.Equals(display.DeviceName, id, StringComparison.OrdinalIgnoreCase));
            if (selected == null) throw new ArgumentException("The requested display is unavailable. Call list_displays again.");
            return selected;
        }

        public static object CaptureDisplay(string id, IDictionary<string, object> args)
        {
            var screens = Screen.AllScreens;
            var display = ResolveDisplay(screens, id);
            var crop = OnScreen(display.Bounds, ParseRegion(args, display.Bounds));
            string png;
            using (var bitmap = new Bitmap(crop.Width, crop.Height, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(bitmap))
                    graphics.CopyFromScreen(crop.Location, Point.Empty, crop.Size);
                png = EncodePng(bitmap);
            }
            if (ResolveDisplay(Screen.AllScreens, display.DeviceName).Bounds != display.Bounds)
                throw new InvalidOperationException("The display layout changed during capture. Call list_displays again.");
            // A display image can include many windows. Only an HWND observation can authorize a click.
            return new { displayId = display.DeviceName, displays = DescribeDisplays(screens), bounds = DescribeBounds(crop),
                width = crop.Width, height = crop.Height, pngBase64 = png };
        }

        public object Capture(string target, IDictionary<string, object> args)
        {
            Clear(); // A failed replacement capture must also retire the previous visual observation.
            IntPtr hwnd;
            var bounds = NativeDesktop.CaptureBounds(target, out hwnd);
            var crop = ParseRegion(args, bounds);
            object requested;
            string source = args.TryGetValue("captureSource", out requested) ? requested as string : "auto";
            if (source != "auto" && source != "print" && source != "compositor")
                throw new ArgumentException("captureSource must be auto, print, or compositor.");
            var image = ReadWindowPixels(target, bounds, crop, ref source);
            if (IsUniform(image, crop.Width, new Rectangle(0, 0, crop.Width, crop.Height)))
                throw new InvalidOperationException("The captured region is blank or a single color. Choose a region containing visible details, " +
                    "or activate the window and use observe_display_visual with the same windowId.");
            string png = EncodePng(image, crop.Width, crop.Height);
            CheckGeometry(target, bounds);
            windowId = target;
            observationId = TokenPrefix + Guid.NewGuid().ToString("N");
            windowBounds = bounds;
            region = crop;
            pixels = image;
            captureSource = source;
            return new { windowId = target, observationId = observationId, captureSource = source, windowBounds = DescribeBounds(bounds), width = crop.Width, height = crop.Height,
                bounds = DescribeBounds(OnScreen(bounds, crop)),
                pngBase64 = png };
        }

        private void ValidatePixels(Rectangle patch)
        {
            var now = captureSource == "display" ? ReadVisiblePatch(patch) : ReadWindowPixels(windowId, windowBounds, patch, ref captureSource);
            ComparePatch(pixels, region, patch, now);
        }

        internal void ValidatePointerGeometry(string target, string id)
        {
            if (observationId == null || id != observationId || target != windowId)
                throw new InvalidOperationException("This visual observation expired or belongs to another window. Capture again.");
            CheckGeometry(target,windowBounds);
        }

        internal Action ValidatePointerObservation(string target, string id, int x, int y, int endX, int endY)
        {
            ValidatePointerGeometry(target,id);
            var screen = OnScreen(windowBounds,region);
            if (!screen.Contains(x,y) || !screen.Contains(endX,endY))
                throw new InvalidOperationException("The pointer endpoints are outside the captured region. Capture the intended path again.");
            var start = ClickPatch(pixels,screen,new Point(x,y),null);
            var end = ClickPatch(pixels,screen,new Point(endX,endY),null);
            start.Offset(-windowBounds.X,-windowBounds.Y);
            end.Offset(-windowBounds.X,-windowBounds.Y);
            return delegate {
                ValidatePointerGeometry(target,id);
                ValidatePixels(start);
                if (end != start) ValidatePixels(end);
            };
        }

        public object Click(string target, string id, int x, int y, string button, Action<int, int, bool> movePointer,
            Rectangle? targetBounds = null, bool requirePointerAtTarget = false)
        {
            if (id != observationId)
                throw new InvalidOperationException("This visual observation expired. Capture the target again.");
            try
            {
                if (target != windowId)
                    throw new InvalidOperationException("The visual observation belongs to another window. Capture the target again.");
                var screen = OnScreen(windowBounds, region);
                if (!screen.Contains(x, y))
                    throw new InvalidOperationException("The point is outside the captured region. Capture the intended target again.");
                var patch = ClickPatch(pixels, screen, new Point(x, y), targetBounds);
                patch.Offset(-windowBounds.X, -windowBounds.Y);
                return NativeDesktop.Click(target, x, y, button, movePointer, delegate { ValidatePixels(patch); }, requirePointerAtTarget);
            }
            finally { Clear(); } // Includes partial double-clicks and validation failures.
        }
    }
}
