using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AgentOS.Computer
{
    // Created, updated and destroyed on the lease's STA message-pump thread.
    internal sealed class DesktopControlOverlay : IDisposable
    {
        private const int NoticeWidth = 230, NoticeHeight = 64, PointerSize = 66, Tip = 20;
        private readonly List<Layer> layers = new List<Layer>();
        private readonly List<Layer> edges = new List<Layer>();
        private readonly Stopwatch layoutCheck = new Stopwatch();
        private readonly Stopwatch pulse = new Stopwatch();
        private readonly Stopwatch breathing = Stopwatch.StartNew();
        private long lastBreathSample;
        private Display[] displays;
        private Layer pointer;
        private Point position;
        private int pointerDpi;
        private bool pressedImage, disposed;

        private struct Display
        {
            public Rectangle Bounds;
            public int Dpi;
            public bool Primary;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(Point point, uint flags);
        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

        private static Display[] ReadDisplays()
        {
            return Screen.AllScreens.Select(screen => {
                Rectangle bounds = screen.Bounds;
                uint dpi, dpiY;
                var monitor = MonitorFromPoint(bounds.Location, 2); // MONITOR_DEFAULTTONEAREST
                if (GetDpiForMonitor(monitor, 0, out dpi, out dpiY) != 0 || dpi == 0) dpi = 96;
                return new Display { Bounds = bounds, Primary = screen.Primary, Dpi = (int)dpi };
            }).ToArray();
        }

        private static int Pixels(int value, int dpi) { return (int)Math.Round(value * (dpi / 96.0)); }

        public void Show()
        {
            if (disposed) throw new ObjectDisposedException("DesktopControlOverlay");
            if (pointer != null) return;
            try { SetLayout(ReadDisplays()); }
            catch { Dispose(); throw; }
        }

        private Layer NewLayer(string name)
        {
            var layer = new Layer(name);
            layers.Add(layer);
            return layer;
        }

        private void SetLayout(Display[] next)
        {
            if (next.Length == 0) throw new InvalidOperationException("No screen is available for the desktop control indicator.");
            if (displays == null || !next.Any(d => d.Bounds.Contains(position)))
            {
                var home = next.FirstOrDefault(d => d.Primary);
                if (home.Bounds.IsEmpty) home = next[0];
                position = new Point(home.Bounds.Left + Math.Min(Pixels(48, home.Dpi), home.Bounds.Width / 3),
                    home.Bounds.Top + Math.Min(Pixels(80, home.Dpi), home.Bounds.Height / 3));
            }
            ClearLayers();
            displays = next;
            foreach (var display in displays) DrawDisplay(display);
            pointer = NewLayer("Pointer");
            pointerDpi = 0;
            UpdatePointer();
            pointer.ShowTopmost();
            layoutCheck.Restart();
        }

        private void DrawDisplay(Display display)
        {
            var bounds = display.Bounds;
            int depth = Math.Min(Pixels(24, display.Dpi), Math.Min(bounds.Width, bounds.Height) / 2);
            // Four non-overlapping strips. The same distance to the display edge determines corner opacity.
            var tiles = new[] {
                new Rectangle(0, 0, bounds.Width, depth),
                new Rectangle(0, bounds.Height - depth, bounds.Width, depth),
                new Rectangle(0, depth, depth, bounds.Height - 2 * depth),
                new Rectangle(bounds.Width - depth, depth, depth, bounds.Height - 2 * depth)
            };
            foreach (var tile in tiles)
            {
                if (tile.Width <= 0 || tile.Height <= 0) continue;
                var layer = NewLayer("Edge");
                edges.Add(layer);
                var destination = tile;
                destination.Offset(bounds.Location);
                layer.Paint(destination, g => DrawEdge(g, tile, bounds.Size, depth));
                layer.ShowTopmost();
            }

            float scale = Math.Min(display.Dpi / 96f,
                Math.Min((float)bounds.Width / NoticeWidth, (float)bounds.Height / NoticeHeight));
            var size = new Size((int)Math.Ceiling(NoticeWidth * scale), (int)Math.Ceiling(NoticeHeight * scale));
            int rightMargin = Math.Min(Pixels(18, display.Dpi), bounds.Width - size.Width);
            var badge = new Rectangle(bounds.Right - rightMargin - size.Width,
                bounds.Top + (bounds.Height - size.Height) / 2, size.Width, size.Height);
            var notice = NewLayer("Notice");
            notice.Paint(badge, g => { g.ScaleTransform(scale, scale); DrawNotice(g); });
            notice.ShowTopmost();
        }

        private static void DrawEdge(Graphics g, Rectangle tile, Size screen, int depth)
        {
            g.TranslateTransform(-tile.X, -tile.Y);
            using (var brush = new SolidBrush(Color.Transparent))
            {
                for (int i = 0; i < depth; i++)
                {
                    double falloff = 1 - (double)i / depth;
                    int alpha = (int)Math.Round(156 * falloff * falloff * falloff);
                    brush.Color = Color.FromArgb(alpha, 77, 178, 163);
                    int width = screen.Width - 2 * i, height = screen.Height - 2 * i;
                    g.FillRectangle(brush, i, i, width, 1);
                    g.FillRectangle(brush, i, screen.Height - i - 1, width, 1);
                    if (height <= 2) continue;
                    g.FillRectangle(brush, i, i + 1, 1, height - 2);
                    g.FillRectangle(brush, screen.Width - i - 1, i + 1, 1, height - 2);
                }
            }
        }

        private static GraphicsPath RoundedRect(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void DrawNotice(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (var shadow = RoundedRect(new RectangleF(3, 5, 224, 57), 13))
            using (var card = RoundedRect(new RectangleF(3, 2, 224, 57), 12))
            using (var shade = new SolidBrush(Color.FromArgb(48, 0, 0, 0)))
            using (var fill = new SolidBrush(Color.FromArgb(248, 23, 37, 44)))
            using (var outline = new Pen(Color.FromArgb(86, 255, 255, 255), 1))
            using (var mint = new SolidBrush(Color.FromArgb(110, 231, 187)))
            using (var detail = new SolidBrush(Color.FromArgb(204, 219, 222)))
            using (var titleFont = new Font("Microsoft YaHei UI", 14, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var detailFont = new Font("Microsoft YaHei UI", 12, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var format = StringFormat.GenericTypographic)
            {
                g.FillPath(shade, shadow);
                g.FillPath(fill, card);
                g.DrawPath(outline, card);
                g.FillEllipse(mint, 15, 18, 7, 7);
                g.DrawString("AgentOS 正在控制你的电脑", titleFont, Brushes.White, 30, 11, format);
                g.DrawString("按 Esc 退出", detailFont, detail, 30, 34, format);
            }
        }

        public void MovePointer(int x, int y, bool pressed)
        {
            if (pointer == null) return;
            var target = new Point(x, y);
            if (pressed) pulse.Restart();
            else if (position == target) return;
            position = target;
            UpdatePointer();
        }

        private void UpdatePointer()
        {
            var display = displays.FirstOrDefault(d => d.Bounds.Contains(position));
            int dpi = display.Dpi != 0 ? display.Dpi : displays[0].Dpi;
            var origin = new Point(position.X - Pixels(Tip, dpi), position.Y - Pixels(Tip, dpi));
            bool pressed = pulse.IsRunning;
            if (dpi == pointerDpi && pressed == pressedImage)
            {
                pointer.Move(origin);
                return;
            }
            int side = Pixels(PointerSize, dpi);
            pointer.Paint(new Rectangle(origin, new Size(side, side)), g => {
                g.ScaleTransform(dpi / 96f, dpi / 96f);
                DrawPointer(g, pressed);
            });
            pointerDpi = dpi;
            pressedImage = pressed;
        }

        private static void DrawPointer(Graphics g, bool pressed)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var haloShape = new GraphicsPath())
            {
                haloShape.AddEllipse(3, 5, 52, 52);
                using (var halo = new PathGradientBrush(haloShape))
                {
                    halo.InterpolationColors = new ColorBlend {
                        Positions = new[] { 0f, .22f, .43f, .69f, 1f },
                        Colors = new[] { Color.Transparent, Color.FromArgb(10, 0, 0, 0),
                            Color.FromArgb(24, 12, 22, 24), Color.FromArgb(66, 255, 255, 255), Color.FromArgb(133, 255, 255, 255) }
                    };
                    g.FillPath(halo, haloShape);
                }
            }
            g.TranslateTransform(Tip, Tip);
            if (pressed)
            {
                using (var ring = new Pen(Color.FromArgb(212, 100, 226, 185), 2))
                    g.DrawEllipse(ring, -12, -12, 24, 24);
                g.ScaleTransform(.82f, .82f);
            }
            var arrow = new[] { PointF.Empty, new PointF(18, 17), new PointF(9.5f, 18), new PointF(5.7f, 26.5f) };
            using (var ink = new SolidBrush(Color.FromArgb(17, 17, 17)))
            using (var line = new Pen(Color.White, 1.4f) { LineJoin = LineJoin.Round })
            {
                g.FillPolygon(ink, arrow);
                g.DrawPolygon(line, arrow);
            }
            using (var badge = RoundedRect(new RectangleF(-10, 27, 48, 15), 4))
            using (var bg = new SolidBrush(Color.FromArgb(238, 23, 37, 44)))
            using (var font = new Font("Segoe UI", 10, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                g.FillPath(bg, badge);
                g.DrawString("AgentOS", font, Brushes.White, -8, 27);
            }
        }

        public void Tick()
        {
            if (pointer == null) return;
            long now = breathing.ElapsedMilliseconds;
            if (now - lastBreathSample >= 40)
            {
                lastBreathSample = now;
                byte alpha = (byte)(234 + Math.Round(21 * Math.Cos(now * (Math.PI * 2 / 4600))));
                foreach (var edge in edges) edge.SetOpacity(alpha);
            }
            if (pulse.IsRunning && pulse.ElapsedMilliseconds >= 230)
            {
                pulse.Reset();
                UpdatePointer();
            }
            if (layoutCheck.ElapsedMilliseconds < 1000) return;
            var next = ReadDisplays();
            if (!displays.SequenceEqual(next)) SetLayout(next);
            else layoutCheck.Restart();
        }

        private void ClearLayers()
        {
            pointer = null;
            edges.Clear();
            foreach (var layer in layers) layer.Dispose();
            layers.Clear();
        }

        public void Dispose()
        {
            disposed = true;
            ClearLayers();
        }

        private sealed class Layer : NativeWindow, IDisposable
        {
            private const int Layered = 0x80000, Transparent = 0x20, ToolWindow = 0x80, NoActivate = 0x08000000;
            private const uint NoSize = 1, NoMove = 2, NoZOrder = 4, NoActivation = 0x10, ShowWindow = 0x40;
            private static readonly IntPtr Topmost = new IntPtr(-1);
            private const string Marker = "AgentOS.ControlOverlay";
            private IntPtr dc, dib, previous;
            private Point origin;
            private Size size;
            private byte opacity = 255;

            public Layer(string name)
            {
                CreateHandle(new CreateParams {
                    Caption = Marker + "." + name, Width = 1, Height = 1,
                    Style = unchecked((int)0x88000000), // WS_POPUP | WS_DISABLED (also skipped by WindowFromPoint)
                    ExStyle = Layered | Transparent | ToolWindow | NoActivate
                });
                if (!SetPropW(Handle, Marker, new IntPtr(1)))
                {
                    var error = new Win32Exception();
                    DestroyHandle();
                    throw error;
                }
            }

            public void ShowTopmost()
            {
                bool excluded = SetWindowDisplayAffinity(Handle, 0x11); // WDA_EXCLUDEFROMCAPTURE where DWM supports it.
                if (!SetWindowPos(Handle, Topmost, 0, 0, 0, 0, ShowWindow | NoActivation | NoMove | NoSize))
                    throw new Win32Exception();
                if (!excluded) SetWindowDisplayAffinity(Handle, 0x11);
            }

            public void Move(Point origin)
            {
                if (!SetWindowPos(Handle, IntPtr.Zero, origin.X, origin.Y, 0, 0, NoSize | NoActivation | NoZOrder))
                    throw new Win32Exception();
                this.origin = origin;
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0084) { m.Result = new IntPtr(-1); return; } // WM_NCHITTEST / HTTRANSPARENT
                if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; } // WM_MOUSEACTIVATE / MA_NOACTIVATE
                base.WndProc(ref m);
            }

            // Keep a small, premultiplied BGRA surface so edge breathing only changes the source-wide alpha.
            public void Paint(Rectangle bounds, Action<Graphics> paint)
            {
                FreeSurface();
                origin = bounds.Location;
                size = bounds.Size;
                var info = new BitmapInfo { HeaderSize = (uint)Marshal.SizeOf(typeof(BitmapInfo)), Width = bounds.Width,
                    Height = -bounds.Height, Planes = 1, BitCount = 32 };
                dc = CreateCompatibleDC(IntPtr.Zero);
                if (dc == IntPtr.Zero) throw new Win32Exception();
                IntPtr bits;
                dib = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
                if (dib == IntPtr.Zero) throw new Win32Exception();
                using (var surface = new Bitmap(size.Width, size.Height, size.Width * 4, PixelFormat.Format32bppPArgb, bits))
                using (var g = Graphics.FromImage(surface))
                {
                    g.Clear(Color.Transparent);
                    paint(g);
                }
                previous = SelectObject(dc, dib);
                if (previous == IntPtr.Zero || previous == new IntPtr(-1)) throw new Win32Exception();
                Present();
            }

            public void SetOpacity(byte alpha)
            {
                if (alpha == opacity) return;
                opacity = alpha;
                Present();
            }

            private void Present()
            {
                var source = Point.Empty;
                var blend = new Blend { Alpha = opacity, Format = 1 }; // AC_SRC_OVER, AC_SRC_ALPHA
                if (!UpdateLayeredWindow(Handle, IntPtr.Zero, ref origin, ref size, dc, ref source, 0, ref blend, 2))
                    throw new Win32Exception();
            }

            private void FreeSurface()
            {
                if (previous != IntPtr.Zero && previous != new IntPtr(-1)) SelectObject(dc, previous);
                if (dc != IntPtr.Zero) DeleteDC(dc);
                if (dib != IntPtr.Zero) DeleteObject(dib);
                previous = dib = dc = IntPtr.Zero;
            }

            public void Dispose()
            {
                FreeSurface();
                if (Handle == IntPtr.Zero) return;
                RemovePropW(Handle, Marker);
                DestroyHandle();
            }

            [StructLayout(LayoutKind.Sequential)]
            private struct BitmapInfo
            {
                public uint HeaderSize;
                public int Width, Height;
                public ushort Planes, BitCount;
                public uint Compression, ImageSize;
                public int XPelsPerMeter, YPelsPerMeter;
                public uint ColorsUsed, ImportantColors;
            }
            [StructLayout(LayoutKind.Sequential)]
            private struct Blend { public byte Operation, Flags, Alpha, Format; }
            [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
            private static extern bool SetPropW(IntPtr hwnd, string name, IntPtr value);
            [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            private static extern IntPtr RemovePropW(IntPtr hwnd, string name);
            [DllImport("user32.dll")] private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
            [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
            [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr targetDC,
                ref Point destination, ref Size size, IntPtr sourceDC, ref Point source, uint colorKey, ref Blend blend, uint flags);
            [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
            [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage,
                out IntPtr bits, IntPtr section, uint offset);
            [DllImport("gdi32.dll", SetLastError = true)] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
            [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
            [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
        }
    }
}
