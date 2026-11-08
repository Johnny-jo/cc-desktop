using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

// Dedicated target for verify-windows-computer.mjs. It never opens user files.
class DesktopFixture
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    struct WindowRect { public int Left, Top, Right, Bottom; }
    struct CursorPoint { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out CursorPoint point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    delegate bool EnumWindow(IntPtr hwnd, IntPtr unused);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr unused);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetProp(IntPtr hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int length);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out WindowRect rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after,
        int x, int y, int width, int height, uint flags);

    delegate IntPtr SubclassProc(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, UIntPtr id, UIntPtr data);
    [DllImport("comctl32.dll", ExactSpelling = true)] static extern bool SetWindowSubclass(
        IntPtr hwnd, SubclassProc callback, UIntPtr id, UIntPtr data);
    [DllImport("comctl32.dll", ExactSpelling = true)] static extern IntPtr DefSubclassProc(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("gdi32.dll")] static extern bool PatBlt(IntPtr dc, int x, int y, int width, int height, uint rop);
    static readonly SubclassProc printFilter = FilterPrint;
    static int printRequests, blackPrints;
    static IntPtr FilterPrint(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, UIntPtr id, UIntPtr data)
    {
        // Paint black only into the print caller's DC. WPF keeps painting the real HWND.
        if (msg == 0x0317 || msg == 0x0318) // WM_PRINT / WM_PRINTCLIENT
        {
            printRequests++;
            WindowRect rect;
            if (GetWindowRect(hwnd, out rect) &&
                PatBlt(wp, 0, 0, rect.Right - rect.Left, rect.Bottom - rect.Top, 0x00000042)) // BLACKNESS
                blackPrints++;
            return IntPtr.Zero;
        }
        return DefSubclassProc(hwnd, msg, wp, lp);
    }
    static object OverlayWindows()
    {
        var overlays = new List<object>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (!IsWindowVisible(hwnd) || GetProp(hwnd, "AgentOS.ControlOverlay") == IntPtr.Zero) return true;
            var title = new StringBuilder(128);
            GetWindowText(hwnd, title, title.Capacity);
            WindowRect rect;
            if (!GetWindowRect(hwnd, out rect)) throw new InvalidOperationException("Cannot measure an overlay");
            overlays.Add(new { title = title.ToString(), x = rect.Left, y = rect.Top,
                width = rect.Right - rect.Left, height = rect.Bottom - rect.Top, style = GetWindowLong(hwnd, -20) });
            return true;
        }, IntPtr.Zero);
        return overlays;
    }

    // The text and the color swatch are painted pixels without child controls.
    sealed class ReportSurface : FrameworkElement
    {
        public readonly Rect ButtonBounds = new Rect(27, 22, 194, 62);
        public readonly Rect SwatchBounds = new Rect(264, 27, 52, 52);
        readonly TextBlock result;
        int saved;
        bool repainted;

        public ReportSurface(TextBlock result)
        {
            this.result = result;
            Height = 108;
        }

        protected override AutomationPeer OnCreateAutomationPeer() { return null; }

        protected override void OnRender(DrawingContext dc)
        {
            dc.DrawRectangle(Brushes.White, null, new Rect(RenderSize));
            dc.DrawRectangle(repainted ? Brushes.Navy : Brushes.White, new Pen(Brushes.Black, 2), ButtonBounds);
            var label = new FormattedText(repainted ? "重新保存" : "保存报告", CultureInfo.GetCultureInfo("zh-CN"),
                FlowDirection.LeftToRight, new Typeface("Microsoft YaHei"), 27, repainted ? Brushes.White : Brushes.Black,
                VisualTreeHelper.GetDpi(this).PixelsPerDip);
            dc.DrawText(label, new Point(ButtonBounds.X + (ButtonBounds.Width - label.Width) / 2,
                ButtonBounds.Y + (ButtonBounds.Height - label.Height) / 2));
            dc.DrawRectangle(Brushes.DodgerBlue, null, SwatchBounds);
        }

        protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
        {
            var point = e.GetPosition(this);
            if (ButtonBounds.Contains(point)) result.Text = "Saved " + (++saved);
            if (SwatchBounds.Contains(point)) result.Text = "Swatch selected";
            base.OnMouseLeftButtonUp(e);
        }

        public void Repaint()
        {
            repainted = true;
            InvalidateVisual();
        }

        public object ScreenBox(Rect rect)
        {
            var start = PointToScreen(rect.TopLeft);
            var end = PointToScreen(rect.BottomRight);
            int x = (int)Math.Round(start.X), y = (int)Math.Round(start.Y);
            return new { x, y, width = (int)Math.Round(end.X) - x, height = (int)Math.Round(end.Y) - y };
        }
    }

    static void AddArchiveButtons(StackPanel panel)
    {
        var row = new DockPanel { LastChildFill = false, Margin = new Thickness(10, 4, 10, 4) };
        var outcome = new TextBlock { Text = "No archive selected" };
        AutomationProperties.SetAutomationId(outcome, "archiveResult");
        foreach (var side in new[] { "Left", "Right" })
        {
            var archive = new Button { Content = "Archive", Width = 130, Height = 44, FontSize = 22 };
            AutomationProperties.SetAutomationId(archive, "archive" + side);
            DockPanel.SetDock(archive, side == "Left" ? Dock.Left : Dock.Right);
            string message = side + " archive selected";
            archive.Click += delegate { outcome.Text = message; };
            row.Children.Add(archive);
        }
        panel.Children.Add(row);
        panel.Children.Add(outcome);
    }

    [STAThread]
    static void Main(string[] args)
    {
        // Measure the drawing in the same physical coordinate space as the MCP helper.
        var perMonitorV2 = new IntPtr(-4);
        SetProcessDpiAwarenessContext(perMonitorV2);
        if (SetThreadDpiAwarenessContext(perMonitorV2) == IntPtr.Zero)
            throw new InvalidOperationException("Cannot enable physical coordinates for the fixture");
        var panel = new StackPanel();
        var form = new Window { Title = args[0], Width = 420, Height = 300, WindowStartupLocation = WindowStartupLocation.CenterScreen, Content = panel };
        var input = new TextBox();
        AutomationProperties.SetAutomationId(input, "entry");
        var button = new Button { Content = "Verify invocation" };
        AutomationProperties.SetAutomationId(button, "button");
        var choice = new ListBox();
        choice.Items.Add(new ListBoxItem { Content = "First choice" });
        var second = new ListBoxItem { Content = "Second choice" };
        AutomationProperties.SetAutomationId(second, "second");
        choice.Items.Add(second);
        var result = new TextBlock { Text = "Ready" };
        AutomationProperties.SetAutomationId(result, "result");
        panel.Children.Add(input); panel.Children.Add(button); panel.Children.Add(choice); panel.Children.Add(result);
        var surface = new ReportSurface(result);
        panel.Children.Add(surface);
        if (Array.IndexOf(args, "--targets") >= 0)
        {
            form.Height = 370;
            AutomationProperties.SetName(input, "Fixture entry");
            AddArchiveButtons(panel);
        }
        button.Click += delegate { result.Text = "Invoked"; };
        choice.SelectionChanged += delegate { result.Text = "Selected " + choice.SelectedIndex; };
        form.PreviewKeyDown += delegate(object sender, KeyEventArgs e) {
            if (e.Key == Key.F5) {
                button.Focus(); // Stop the entry caret blinking during subsequent screenshot comparisons.
                result.Text = "Shortcut received";
            }
        };
        form.ContentRendered += delegate {
            form.Activate();
            input.Focus();
            var json = new JavaScriptSerializer();
            var hwnd = new WindowInteropHelper(form).Handle;
            CursorPoint original = new CursorPoint(), nudged = new CursorPoint();
            Func<object> geometry = delegate {
                CursorPoint cursor;
                if (!GetCursorPos(out cursor)) throw new InvalidOperationException("Cannot read cursor");
                return new { button = surface.ScreenBox(surface.ButtonBounds), swatch = surface.ScreenBox(surface.SwatchBounds),
                    cursor = new { x = cursor.X, y = cursor.Y },
                    scale = VisualTreeHelper.GetDpi(surface).DpiScaleX, printRequests, blackPrints };
            };
            Console.WriteLine(json.Serialize(geometry()));
            new Thread(delegate() {
                string command;
                while ((command = Console.ReadLine()) != null) {
                    form.Dispatcher.Invoke(new Action(delegate {
                        if (command == "repaint") surface.Repaint();
                        else if (command == "move") form.Left += 32;
                        else if (command.StartsWith("place "))
                        {
                            var parts = command.Split(' ');
                            if (!SetWindowPos(hwnd, IntPtr.Zero, int.Parse(parts[1]), int.Parse(parts[2]),
                                0, 0, 0x15)) // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                                throw new InvalidOperationException("Cannot position the fixture");
                        }
                        else if (command == "black-print")
                        {
                            button.Focus(); // Keep OCR and pixel checks clear of a blinking caret.
                            if (!SetWindowSubclass(hwnd, printFilter, new UIntPtr(1), UIntPtr.Zero))
                                throw new InvalidOperationException("Cannot intercept WM_PRINT in the fixture");
                        }
                        else if (command == "nudge")
                        {
                            GetCursorPos(out original);
                            SetCursorPos(original.X + 12, original.Y);
                            GetCursorPos(out nudged);
                            if (nudged.X == original.X) { SetCursorPos(original.X - 12, original.Y); GetCursorPos(out nudged); }
                        }
                        else if (command == "undo-nudge")
                        {
                            CursorPoint now;
                            if (GetCursorPos(out now) && now.Equals(nudged)) SetCursorPos(original.X, original.Y);
                        }
                        else if (command == "overlays" || command == "geometry") return;
                        else throw new ArgumentException("Unknown fixture command");
                    }));
                    // Acknowledge after WPF processes layout and render work.
                    form.Dispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(delegate {
                        Console.WriteLine(json.Serialize(new { applied = command, geometry = geometry(),
                            overlays = command == "overlays" ? OverlayWindows() : null }));
                    }));
                }
            }) { IsBackground = true }.Start();
        };
        new Application().Run(form);
    }
}
