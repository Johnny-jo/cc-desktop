using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace AgentOS.Computer
{
    internal static class NativeDesktop
    {
        // Installed only in the elevated window-scoped worker.
        internal static Action<IntPtr> ValidateScopedHandle { get; set; }
        private const uint Root = 2; // GA_ROOT stops at the top-level window, including an owned dialog.
        private const uint KeyInput = 1, KeyExtended = 1, KeyUp = 2, KeyUnicode = 4;
        private const uint LeftDown = 2, LeftUp = 4, RightDown = 8, RightUp = 16;
        private const uint MouseMove = 0x0001, MouseVirtualDesk = 0x4000, MouseAbsolute = 0x8000;
        private const int VirtualLeft = 76, VirtualTop = 77, VirtualWidth = 78, VirtualHeight = 79;
        private const int Control = 0x11, Shift = 0x10, Alt = 0x12, Win = 0x5b;
        private const string InputAccessHint = "Use the unlocked interactive desktop. Windows can block input " +
            "from a standard process to an administrator window (UIPI). The user can authorize control of that window.";

        [StructLayout(LayoutKind.Sequential)]
        private struct Point { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct GuiThreadInfo
        {
            public int Size, Flags;
            public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
            public Rect CaretRect;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MouseInput
        {
            public int X, Y;
            public uint Data, Flags, Time;
            public UIntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput
        {
            public ushort Key, Scan;
            public uint Flags, Time;
            public UIntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputData
        {
            [FieldOffset(0)] public MouseInput Mouse;
            [FieldOffset(0)] public KeyboardInput Keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Input { public uint Type; public InputData Data; }

        private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetProp(IntPtr hwnd, string name);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int capacity);
        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll")] private static extern bool GetClipCursor(out Rect rect);
        [DllImport("user32.dll")] private static extern uint GetDoubleClickTime();
        [DllImport("user32.dll", SetLastError = true)] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, [In] Input[] events, int inputSize);
        [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

        public static void EnableDpiAwareness()
        {
            var perMonitorV2 = new IntPtr(-4);
            SetProcessDpiAwarenessContext(perMonitorV2); // A manifest or an earlier call may have set the default.
            if (SetThreadDpiAwarenessContext(perMonitorV2) == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enable physical screen coordinates.");
        }

        private static bool VisibleWindow(IntPtr hwnd)
        {
            int cloaked;
            return IsWindowVisible(hwnd) && GetAncestor(hwnd, Root) == hwnd && GetProp(hwnd, "AgentOS.ControlOverlay") == IntPtr.Zero &&
                (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) != 0 || cloaked == 0);
        }

        public static object ListWindows()
        {
            var result = new List<object>();
            var foreground = GetForegroundWindow();
            bool enumerated = EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
            {
                uint pid;
                Rect rect;
                if (!VisibleWindow(hwnd) || GetWindowThreadProcessId(hwnd, out pid) == 0 ||
                    !GetWindowRect(hwnd, out rect)) return true;
                var title = new StringBuilder(GetWindowTextLength(hwnd) + 1);
                GetWindowText(hwnd, title, title.Capacity);
                result.Add(new {
                    windowId = String.Format(CultureInfo.InvariantCulture, "{0:x}:{1}", hwnd.ToInt64(), pid),
                    title = title.ToString(), pid = pid,
                    bounds = new { x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top },
                    foreground = foreground == hwnd
                });
                return true;
            }, IntPtr.Zero);
            if (!enumerated) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enumerate desktop windows.");
            return result.ToArray();
        }

        public static IntPtr Resolve(string windowId)
        {
            uint pid;
            return Resolve(windowId, out pid);
        }

        internal static IntPtr Resolve(string windowId, out uint pid)
        {
            var parts = (windowId ?? "").Split(':');
            long handle;
            if (parts.Length != 2 || !Int64.TryParse(parts[0], NumberStyles.AllowHexSpecifier,
                CultureInfo.InvariantCulture, out handle) || handle <= 0 ||
                !UInt32.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0)
                throw new ArgumentException("Invalid windowId. Obtain a windowId from the current desktop.");

            var hwnd = new IntPtr(handle);
            // EnumWindows scopes even a fabricated handle to this worker's own desktop.
            bool found = false;
            EnumWindows(delegate(IntPtr candidate, IntPtr unused)
            {
                found = candidate == hwnd;
                return !found;
            }, IntPtr.Zero);
            uint actualPid;
            if (!found || !VisibleWindow(hwnd) || GetWindowThreadProcessId(hwnd, out actualPid) == 0 || actualPid != pid)
                throw new InvalidOperationException("The desktop window has changed or closed. Observe the desktop again.");
            var validate = ValidateScopedHandle;
            if (validate != null) validate(hwnd);
            return hwnd;
        }

        private static bool WaitForForeground(IntPtr hwnd)
        {
            for (int attempt = 0; attempt < 20 && GetForegroundWindow() != hwnd; attempt++) Thread.Sleep(15);
            return GetForegroundWindow() == hwnd;
        }

        private static InvalidOperationException InputAccessBlocked(string message)
        {
            var error = new InvalidOperationException(message);
            error.Data["code"] = "input_access_blocked";
            return error;
        }

        private static string RequestAccessibleFocus(string windowId, IntPtr previous, out bool focusRefused)
        {
            focusRefused = false;
            bool requested = false;
            var hwnd = Resolve(windowId);
            if (IsIconic(hwnd) || !IsWindowEnabled(hwnd))
                return "The target is minimized or disabled. Check for an active dialog.";
            try
            {
                var element = AutomationElement.FromHandle(hwnd);
                if (element == null) return "The target has no accessibility element for focus.";
                // Mere pointer motion does not change the window receiving keyboard input.
                // Respect an ongoing gesture or a switch to another foreground window.
                var info = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
                SetLastError(0);
                if (!GetGUIThreadInfo(0, ref info))
                    return "Cannot inspect the foreground input queue (" + DescribeError(Marshal.GetLastWin32Error()) + ").";
                if (info.Capture != IntPtr.Zero || info.MenuOwner != IntPtr.Zero || info.MoveSize != IntPtr.Zero ||
                    (info.Flags & 0x1e) != 0) // GUI_INMOVESIZE, GUI_INMENUMODE, GUI_SYSTEMMENUMODE, GUI_POPUPMENUMODE
                    return "A mouse capture, menu, move or resize is active.";
                RequireMouseReleased();
                if (previous == IntPtr.Zero || info.Active != previous || GetForegroundWindow() != previous)
                    return "The foreground window changed before the accessibility focus request.";
                requested = true;
                element.SetFocus();
                if (WaitForForeground(hwnd)) return null;
                focusRefused = true;
                return "The target's accessibility provider did not grant foreground focus.";
            }
            catch (Exception error)
            {
                if (error is UnauthorizedAccessException || error.HResult == unchecked((int)0x80070005))
                {
                    focusRefused = true;
                    return "UI Automation focus was denied. " + InputAccessHint;
                }
                if (!(error is InvalidOperationException || error is ElementNotAvailableException ||
                    error is ElementNotEnabledException || error is COMException)) throw;
                focusRefused = requested && !(error is ElementNotAvailableException || error is ElementNotEnabledException);
                return "UI Automation focus failed: " + error.Message;
            }
        }

        public static object Activate(string windowId)
        {
            var hwnd = Resolve(windowId);
            if (!IsWindowEnabled(hwnd))
                throw new InvalidOperationException("The window is disabled. Observe the desktop for its active dialog.");
            var previous = GetForegroundWindow();
            if (IsIconic(hwnd))
            {
                ShowWindowAsync(hwnd, 9); // SW_RESTORE, without waiting for a hung target's message loop.
                for (int attempt = 0; attempt < 20 && IsIconic(hwnd); attempt++) Thread.Sleep(15);
            }
            if (GetForegroundWindow() != hwnd)
            {
                bool accepted = SetForegroundWindow(Resolve(windowId));
                // SetForegroundWindow may queue activation on the target thread.
                if (!WaitForForeground(hwnd))
                {
                    bool focusRefused;
                    string reason = RequestAccessibleFocus(windowId, previous, out focusRefused);
                    var foreground = GetForegroundWindow();
                    if (foreground != hwnd)
                    {
                        string message = String.Format(CultureInfo.InvariantCulture,
                            "Windows kept a different window in the foreground (requested {0}, foreground HWND 0x{1:x}, " +
                            "SetForegroundWindow returned {2}). {3} Bring the requested window to the front, then inspect it again.",
                            windowId, foreground.ToInt64(), accepted, reason ?? "Foreground changed after activation.");
                        if (focusRefused && previous != IntPtr.Zero && foreground == previous)
                            throw InputAccessBlocked(message);
                        throw new InvalidOperationException(message);
                    }
                }
            }
            RequireForeground(windowId);
            return new { windowId = windowId, foreground = true };
        }

        public static System.Drawing.Rectangle CaptureBounds(string windowId, out IntPtr hwnd)
        {
            hwnd = Resolve(windowId);
            if (IsIconic(hwnd))
                throw new InvalidOperationException("The target window is minimized. Restore it before capturing it.");
            uint affinity;
            if (GetWindowDisplayAffinity(hwnd, out affinity) && affinity != 0)
                throw new InvalidOperationException("The target window protects its content from capture.");
            Rect rect;
            if (!GetWindowRect(hwnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top)
                throw new InvalidOperationException("The window has no available capture bounds. Observe the desktop again.");
            return new System.Drawing.Rectangle(rect.Left, rect.Top,
                checked(rect.Right - rect.Left), checked(rect.Bottom - rect.Top));
        }

        private static IntPtr RequireForeground(string windowId)
        {
            var hwnd = Resolve(windowId);
            if (GetForegroundWindow() != hwnd || IsIconic(hwnd) || !IsWindowEnabled(hwnd))
                throw new InvalidOperationException("The target is not the active foreground window. Observe and activate it.");
            return hwnd;
        }

        private static GuiThreadInfo InputTarget(string windowId)
        {
            var hwnd = RequireForeground(windowId);
            var info = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
            if (!GetGUIThreadInfo(0, ref info) || info.Active != hwnd ||
                (info.MenuOwner != IntPtr.Zero && GetAncestor(info.MenuOwner, Root) != hwnd))
                throw new InvalidOperationException("The foreground input target changed. Observe the desktop again.");
            return info;
        }

        private static void RequireReleased(int key)
        {
            if (GetAsyncKeyState(key) < 0)
                throw new InvalidOperationException("An input key or mouse button is already held. Release it before retrying.");
        }

        private static void RequireReleasedModifiers()
        {
            RequireReleased(Control);
            RequireReleased(Shift);
            RequireReleased(Alt);
            RequireReleased(Win);
            RequireReleased(0x5c); // VK_RWIN
        }

        private static void CheckPoint(string windowId, Point point)
        {
            var info = InputTarget(windowId);
            if (GetAncestor(WindowFromPoint(point), Root) != info.Active ||
                (info.Capture != IntPtr.Zero && GetAncestor(info.Capture, Root) != info.Active))
                throw new InvalidOperationException("The point or mouse capture belongs to another window. Observe again.");
        }

        internal static int NormalizeMouseCoordinate(int coordinate, int origin, int extent)
        {
            long offset = (long)coordinate - origin;
            if (offset < 0 || offset >= extent)
                throw new InvalidOperationException("The point is outside the current virtual desktop. Observe the desktop again.");
            // Windows selects pixel floor(absolute * extent / 65536). Aim inside that pixel's
            // interval, including at a negative monitor origin or at either desktop edge.
            long first = (offset * 65536 + extent - 1) / extent;
            long end = ((offset + 1) * 65536 + extent - 1) / extent;
            if (first == end)
                throw new InvalidOperationException("This physical pixel cannot be addressed by absolute mouse input at the current desktop size.");
            return (int)((first + end - 1) / 2);
        }

        private static string DescribeError(int code)
        {
            return code == 0 ? "no extended Win32 error" :
                String.Format(CultureInfo.InvariantCulture, "Win32 {0}: {1}", code, new Win32Exception(code).Message);
        }

        private static Point CursorPosition()
        {
            Point point;
            SetLastError(0);
            if (!GetCursorPos(out point))
                throw new InvalidOperationException("GetCursorPos failed (" + DescribeError(Marshal.GetLastWin32Error()) +
                    "). Use the unlocked interactive desktop, then inspect the target again.");
            return point;
        }

        private static void RequireCursor(Point expected, Point actual)
        {
            if (actual.X != expected.X || actual.Y != expected.Y)
                throw new InvalidOperationException(String.Format(CultureInfo.InvariantCulture,
                    "The cursor moved or was clipped (expected {0},{1}, actual {2},{3}). Observe the desktop again.",
                    expected.X, expected.Y, actual.X, actual.Y));
        }

        private static Point? returnPoint;
        private static Point agentPoint;
        // Only the native move records a return address. The model cannot supply it.
        internal static void FinishPointer()
        {
            Point? home = returnPoint;
            returnPoint = null;
            Point actual;
            Rect clip;
            if (!home.HasValue || !GetCursorPos(out actual) || actual.X != agentPoint.X || actual.Y != agentPoint.Y ||
                !GetClipCursor(out clip) || home.Value.X < clip.Left || home.Value.X >= clip.Right ||
                home.Value.Y < clip.Top || home.Value.Y >= clip.Bottom) return;
            foreach (int key in new[] { 1, 2, 4, 5, 6 }) if ((GetAsyncKeyState(key) & 0x8000) != 0) return;
            int left = GetSystemMetrics(VirtualLeft), top = GetSystemMetrics(VirtualTop);
            int width = GetSystemMetrics(VirtualWidth), height = GetSystemMetrics(VirtualHeight);
            if (width <= 0 || width > 65536 || height <= 0 || height > 65536 ||
                home.Value.X < left || home.Value.X >= (long)left + width ||
                home.Value.Y < top || home.Value.Y >= (long)top + height) return;
            var move = new MouseInput {
                X = NormalizeMouseCoordinate(home.Value.X, left, width),
                Y = NormalizeMouseCoordinate(home.Value.Y, top, height),
                Flags = MouseMove | MouseAbsolute | MouseVirtualDesk
            };
            SendInput(1, new[] { new Input { Data = new InputData { Mouse = move } } }, Marshal.SizeOf(typeof(Input)));
        }

        private static bool MoveCursor(string windowId, Point target)
        {
            int left = GetSystemMetrics(VirtualLeft), top = GetSystemMetrics(VirtualTop);
            int width = GetSystemMetrics(VirtualWidth), height = GetSystemMetrics(VirtualHeight);
            var move = new MouseInput {
                X = NormalizeMouseCoordinate(target.X, left, width), Y = NormalizeMouseCoordinate(target.Y, top, height),
                Flags = MouseMove | MouseAbsolute | MouseVirtualDesk
            };
            Rect clip;
            bool haveClip = GetClipCursor(out clip);
            if (haveClip && (target.X < clip.Left || target.X >= clip.Right || target.Y < clip.Top || target.Y >= clip.Bottom))
                throw new InvalidOperationException(String.Format(CultureInfo.InvariantCulture,
                    "The target ({0},{1}) is outside the cursor clip rectangle [{2},{3},{4},{5}). " +
                    "Release the application's cursor confinement, then inspect the target again.",
                    target.X, target.Y, clip.Left, clip.Top, clip.Right, clip.Bottom));
            // Screenshot validation can take time. The pointer's old location is
            // irrelevant to the requested destination until we actually send the move.
            Point original = CursorPosition();
            if (original.X == target.X && original.Y == target.Y) return false;
            var events = new[] { new Input { Data = new InputData { Mouse = move } } };
            int size = Marshal.SizeOf(typeof(Input));
            SetLastError(0);
            bool accepted = SendInput(1, events, size) == 1;
            int error = Marshal.GetLastWin32Error();
            string failure;
            if (!accepted)
            {
                failure = String.Format(CultureInfo.InvariantCulture,
                    "SendInput rejected the pointer move to ({0},{1}) on virtual desktop ({2},{3}) {4}x{5} ({6}). {7}",
                    target.X, target.Y, left, top, width, height, DescribeError(error), InputAccessHint);
            }
            else
            {
                // The move may still be queued. Stop waiting on the first change, including user motion.
                Point actual = CursorPosition();
                for (int i = 0; i < 20 && actual.X == original.X && actual.Y == original.Y; i++)
                {
                    Thread.Sleep(5);
                    actual = CursorPosition();
                }
                if (actual.X != original.X || actual.Y != original.Y)
                {
                    RequireCursor(target, actual);
                    returnPoint = original;
                    agentPoint = target;
                    return true;
                }
                failure = String.Format(CultureInfo.InvariantCulture,
                    "SendInput accepted the pointer move to ({0},{1}), but the cursor stayed at ({2},{3}). " +
                    "No mouse button was pressed. {4}", target.X, target.Y, original.X, original.Y, InputAccessHint);
            }

            // This classification is used for a scoped authorization prompt. Preserve ordinary errors
            // when clipping, the foreground target, held buttons or cursor position changed.
            Rect currentClip;
            if (!haveClip || !GetClipCursor(out currentClip) || currentClip.Left != clip.Left ||
                currentClip.Right != clip.Right || currentClip.Top != clip.Top || currentClip.Bottom != clip.Bottom)
                throw new InvalidOperationException("Cursor clipping could not be verified or changed during the move. Observe the target again.");
            RequireMouseReleased();
            CheckPoint(windowId, target);
            RequireCursor(original, CursorPosition());
            throw InputAccessBlocked(failure);
        }

        private static void RequireMouseReleased()
        {
            RequireReleasedModifiers();
            foreach (int key in new[] { 1, 2, 4, 5, 6 }) RequireReleased(key);
        }

        public static object Click(string windowId, int x, int y, string button,
            Action<int, int, bool> movePointer, Action validatePixels = null, bool requirePointerAtTarget = false)
        {
            if (button != "left" && button != "right" && button != "double")
                throw new ArgumentException("button must be left, right or double.");
            var point = new Point { X = x, Y = y };
            CheckPoint(windowId, point);
            RequireMouseReleased();
            Point cursor = CursorPosition();
            if (requirePointerAtTarget) RequireCursor(point, cursor);
            bool moved = false;
            if (cursor.X != x || cursor.Y != y)
            {
                if (validatePixels != null) validatePixels();
                RequireMouseReleased();
                CheckPoint(windowId, point);
                moved = MoveCursor(windowId, point);
                movePointer(x, y, false);
            }
            uint press = button == "right" ? RightDown : LeftDown;
            var down = new Input { Data = new InputData { Mouse = new MouseInput { Flags = press } } };
            var events = new[] { down, Release(down) };
            int clicks = button == "double" ? 2 : 1;
            int completed = 0;
            bool keepHover = false;
            var interval = new Stopwatch();
            try
            {
                while (completed < clicks)
                {
                    // Hover or the first click can move content within the same HWND.
                    if (validatePixels != null) validatePixels();
                    RequireMouseReleased();
                    CheckPoint(windowId, point); // Moving the cursor or the first click can expose another window.
                    RequireCursor(point, CursorPosition());
                    if (completed > 0 && interval.ElapsedMilliseconds >= GetDoubleClickTime())
                        throw new InvalidOperationException("The double-click interval elapsed during target validation.");
                    if (completed == 0 && clicks == 2) interval.Start();
                    SendBalanced(events);
                    completed++;
                    movePointer(x, y, true);
                }
            }
            catch (Exception error)
            {
                if (moved && completed == 0 && button == "left" && Object.Equals(error.Data["code"], "observed_pixels_changed"))
                {
                    RequireMouseReleased();
                    CheckPoint(windowId, point);
                    RequireCursor(point, CursorPosition());
                    error.Data["code"] = "hover_changed_before_press";
                    keepHover = true;
                }
                if (completed == 0) throw;
                throw new InvalidOperationException("The first click was already sent. Inspect the target before retrying. " + error.Message, error);
            }
            finally { if (!keepHover) FinishPointer(); }
            return new { windowId = windowId, x = x, y = y, button = button };
        }

        private static IntPtr KeyboardFocus(string windowId)
        {
            var info = InputTarget(windowId);
            if (info.Focus == IntPtr.Zero || GetAncestor(info.Focus, Root) != info.Active)
                throw new InvalidOperationException("Keyboard focus is outside the target. Focus the intended control first.");
            return info.Focus;
        }

        private static Input KeyEvent(ushort key, ushort scan, uint flags)
        {
            var keyboard = new KeyboardInput { Key = key, Scan = scan, Flags = flags };
            return new Input { Type = KeyInput, Data = new InputData { Keyboard = keyboard } };
        }

        public static object TypeText(string windowId, string text)
        {
            if (text == null) throw new ArgumentNullException("text");
            var focus = KeyboardFocus(windowId);
            int offset = 0;
            try
            {
                while (offset < text.Length)
                {
                    int count = Math.Min(64, text.Length - offset);
                    if (offset + count < text.Length && Char.IsSurrogatePair(text, offset + count - 1)) count--;
                    var events = new Input[count * 2];
                    for (int i = 0; i < count; i++)
                    {
                        var down = KeyEvent(0, text[offset + i], KeyUnicode);
                        events[i * 2] = down;
                        events[i * 2 + 1] = Release(down);
                    }
                    RequireReleasedModifiers();
                    if (KeyboardFocus(windowId) != focus)
                        throw new InvalidOperationException("Keyboard focus changed during typing.");
                    SendBalanced(events);
                    offset += count;
                }
            }
            catch (InvalidOperationException e)
            {
                throw new InvalidOperationException(String.Format(CultureInfo.InvariantCulture,
                    "{0} Completed text units before this batch: {1}. Observe the field before retrying.", e.Message, offset), e);
            }
            return new { windowId = windowId, utf16Units = offset };
        }

        private static readonly Dictionary<string, ushort> NamedKeys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
            {"Control", Control}, {"Ctrl", Control}, {"Shift", Shift}, {"Alt", Alt}, {"Win", Win}, {"Meta", Win},
            {"Enter", 0x0d}, {"Return", 0x0d}, {"Tab", 9}, {"Escape", 0x1b}, {"Esc", 0x1b}, {"Space", 0x20},
            {"Backspace", 8}, {"Delete", 0x2e}, {"Insert", 0x2d}, {"Home", 0x24}, {"End", 0x23},
            {"PageUp", 0x21}, {"PageDown", 0x22}, {"Left", 0x25}, {"Up", 0x26}, {"Right", 0x27}, {"Down", 0x28},
            {"ArrowLeft", 0x25}, {"ArrowUp", 0x26}, {"ArrowRight", 0x27}, {"ArrowDown", 0x28}
        };

        private static ushort KeyCode(string value)
        {
            string key = (value ?? "").Trim().ToUpperInvariant();
            ushort code;
            if (NamedKeys.TryGetValue(key, out code)) return code;
            if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9')))
                return key[0];
            int function;
            if (key.StartsWith("F", StringComparison.Ordinal) &&
                Int32.TryParse(key.Substring(1), NumberStyles.None, CultureInfo.InvariantCulture, out function) &&
                function >= 1 && function <= 24) return (ushort)(0x70 + function - 1);
            throw new ArgumentException("Unrecognized shortcut key: " + value);
        }

        public static object Shortcut(string windowId, string[] keys)
        {
            if (keys == null || keys.Length == 0 || keys.Length > 5)
                throw new ArgumentException("A shortcut takes up to four modifiers followed by one key.");
            var codes = new HashSet<ushort>();
            var events = new Input[2 * keys.Length];
            for (int i = 0; i < keys.Length; i++)
            {
                ushort code = KeyCode(keys[i]);
                bool modifier = code == Alt || code == Control || code == Win || code == Shift;
                if (!codes.Add(code) || (i < keys.Length - 1 && !modifier) || (keys.Length > 1 && modifier && i == keys.Length - 1))
                    throw new ArgumentException("Use distinct modifiers followed by one primary key.");
                bool extended = (code >= 0x21 && code <= 0x28) || code == 0x2d || code == 0x2e || code == Win;
                var down = KeyEvent(code, 0, extended ? KeyExtended : 0);
                events[i] = down;
                events[events.Length - i - 1] = Release(down);
            }
            RequireReleasedModifiers();
            foreach (ushort code in codes) RequireReleased(code);
            KeyboardFocus(windowId);
            SendBalanced(events);
            return new { windowId = windowId, keys = keys };
        }

        private static Input Release(Input down)
        {
            if (down.Type == KeyInput) down.Data.Keyboard.Flags |= KeyUp;
            else down.Data.Mouse.Flags = down.Data.Mouse.Flags == LeftDown ? LeftUp : RightUp;
            return down;
        }

        private static void SendBalanced(Input[] events)
        {
            // All callers submit balanced, nested down/up sequences in a single SendInput call.
            int size = Marshal.SizeOf(typeof(Input));
            SetLastError(0);
            uint sent = SendInput((uint)events.Length, events, size);
            if (sent == events.Length) return;
            int error = Marshal.GetLastWin32Error();
            var held = new Stack<Input>();
            for (int i = 0; i < sent; i++)
            {
                var current = events[i];
                bool released = current.Type == KeyInput ? (current.Data.Keyboard.Flags & KeyUp) != 0 :
                    (current.Data.Mouse.Flags & (LeftUp | RightUp)) != 0;
                if (released) held.Pop();
                else held.Push(Release(current));
            }
            // Only release our own accepted downs. Never replay the action after a partial insertion.
            uint releasedCount = held.Count == 0 ? 0 : SendInput((uint)held.Count, held.ToArray(), size);
            throw new InvalidOperationException(String.Format(CultureInfo.InvariantCulture,
                "SendInput accepted {0}/{1} events ({2}). Released {3}/{4} held inputs. {5} Observe the target before retrying.",
                sent, events.Length, DescribeError(error), releasedCount, held.Count, InputAccessHint));
        }
    }
}
