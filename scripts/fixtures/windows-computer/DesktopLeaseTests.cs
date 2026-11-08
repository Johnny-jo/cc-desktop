using System;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace AgentOS.Computer
{
    // The real lease drives this recorder on its own STA. No visible windows or input.
    sealed class DesktopControlOverlay : IDisposable
    {
        internal static int Shows, Closes, Moves, X, Y, Presses;
        internal static bool FailShow;
        internal static Action OnTick;
        readonly Thread owner = Thread.CurrentThread;

        void CheckThread()
        {
            DesktopLeaseTests.Check(Thread.CurrentThread == owner && owner.GetApartmentState() == ApartmentState.STA,
                "Overlay must stay on its STA");
        }
        public void Show()
        {
            CheckThread();
            if (FailShow) throw new InvalidOperationException("Fixture overlay unavailable");
            Interlocked.Increment(ref Shows);
        }
        public void MovePointer(int x, int y, bool pressed)
        {
            CheckThread();
            X = x; Y = y;
            if (pressed) Interlocked.Increment(ref Presses);
            Interlocked.Increment(ref Moves);
        }
        public void Tick() { CheckThread(); if (OnTick != null) OnTick(); }
        public void Dispose() { CheckThread(); Interlocked.Increment(ref Closes); }
    }

    // The parent selects an invisible desktop for all threads of the child,
    // including the thread that installs the real hotkey and keyboard hook.
    static class DesktopLeaseTests
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo
        {
            public int size;
            public string reserved, desktop, title;
            public int x, y, width, height, columns, rows, attribute, flags;
            public short show, reservedSize;
            public IntPtr reservedBytes, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string file, string command, IntPtr processSecurity, IntPtr threadSecurity,
            bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out int code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, int code);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window, int id);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);

        internal static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
        static bool CanReserveStopChord()
        {
            if (!RegisterHotKey(IntPtr.Zero, 1, 0x4003, 0x79)) return false;
            UnregisterHotKey(IntPtr.Zero, 1);
            return true;
        }
        static void TestLease()
        {
            using (var lease = new DesktopLease(new Mutex(false)))
            {
                var idle = (System.Diagnostics.Stopwatch)typeof(DesktopLease).GetField("idle",
                    BindingFlags.NonPublic | BindingFlags.Instance).GetValue(lease);
                lease.NoteActivity();
                Check(!idle.IsRunning && CanReserveStopChord(), "A passive query must not start control");
                for (int i = 0; i < 2; i++)
                {
                    lease.BeginFrame();
                    Check(!CanReserveStopChord(), "Screenshot must keep emergency stop armed");
                    lease.EndFrame();
                    Check(CanReserveStopChord() && DesktopControlOverlay.Shows == 0,
                        "Read-only observations must release the lease without flashing a control banner");
                }
                lease.Acquire();
                Check(DesktopControlOverlay.Shows == 1, "Control banner must be visible before the first write returns");
                idle.Stop();
                lease.NoteActivity();
                Check(idle.IsRunning, "Read-only activity must restart the idle window for the current owner");
                lease.Acquire();
                lease.BeginFrame();
                lease.EndFrame();
                Check(!CanReserveStopChord() && DesktopControlOverlay.Shows == 1 && DesktopControlOverlay.Closes == 0,
                    "Actions and observations during control must share one continuous indicator");
                lease.MovePointer(-120, 80, true);
                lease.MovePointer(-119, 81, false);
                Check(SpinWait.SpinUntil(delegate { return Volatile.Read(ref DesktopControlOverlay.Moves) > 0 &&
                    DesktopControlOverlay.X == -119 && DesktopControlOverlay.Y == 81; }, 2000), "Latest pointer must reach STA");
                Check(DesktopControlOverlay.Presses > 0, "Coalescing must preserve click animation");
                lease.Release();
                Check(DesktopControlOverlay.Closes == 1 && CanReserveStopChord(), "Release must close the overlay and hotkey");

                lease.BeginFrame();
                lease.Acquire();
                lease.EndFrame();
                Check(DesktopControlOverlay.Shows == 2 && !CanReserveStopChord(), "Frame borrowed before a write must upgrade to control");
                lease.Release();

                Check(RegisterHotKey(IntPtr.Zero, 1, 0x4003, 0x79), "Fixture must reserve chord");
                bool refused = false;
                try { lease.Acquire(); }
                catch (Win32Exception) { refused = true; }
                finally { UnregisterHotKey(IntPtr.Zero, 1); }
                Check(refused && DesktopControlOverlay.Shows == 2, "Hotkey registration failure must prevent control");
                DesktopControlOverlay.FailShow = true;
                refused = false;
                try { lease.Acquire(); }
                catch (InvalidOperationException) { refused = true; }
                DesktopControlOverlay.FailShow = false;
                Check(refused && CanReserveStopChord(), "A failed banner must release emergency registrations");
                lease.Acquire();
            }
            Check(DesktopControlOverlay.Closes == 4 && CanReserveStopChord(), "Disposal must close each created overlay and release the chord");
            foreach (int message in new int[] { 0x0100, 0x0104 })
            {
                foreach (int flags in new int[] { 0, 0x10, 0x12 })
                {
                    bool stopping = false;
                    bool suppressed = DesktopLease.SuppressEscape(message, 0x1b, flags, ref stopping);
                    Check(suppressed == (flags == 0) && stopping == suppressed, "Only a physical Escape down may cancel input");
                }
            }
            bool stopped = false;
            Check(!DesktopLease.SuppressEscape(0x0101, 0x1b, 0, ref stopped) && !stopped, "An old Escape key-up must not stop a new lease");
            Check(!DesktopLease.SuppressEscape(0x0100, 0x41, 0, ref stopped) && !stopped, "Ordinary physical keys must pass through");
            stopped = true;
            Check(DesktopLease.SuppressEscape(0x0101, 0x1b, 0, ref stopped), "The matching Escape key-up must be suppressed during shutdown");
        }

        static void TestConcurrentStop()
        {
            using (var lease = new DesktopLease(new Mutex(false)))
            using (var entered = new ManualResetEvent(false))
            {
                // Arrange delivery at the exact boundary where release is waiting
                // for the STA to finish. No input enters the desktop's input queue.
                var ending = (WaitHandle)typeof(DesktopLease).GetField("ending", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(lease);
                DesktopControlOverlay.OnTick = delegate
                {
                    try
                    {
                        entered.Set();
                        Check(ending.WaitOne(2000), "Release must reach the STA");
                        IntPtr handle = IntPtr.Zero;
                        while ((handle = FindWindowEx(new IntPtr(-3), handle, null, null)) != IntPtr.Zero)
                        {
                            var window = NativeWindow.FromHandle(handle);
                            if (window == null || window.GetType().Name != "StopWindow") continue;
                            var callback = window.GetType().GetMethod("OnKeyboard", BindingFlags.NonPublic | BindingFlags.Instance);
                            IntPtr key = Marshal.AllocHGlobal(24);
                            try
                            {
                                Marshal.WriteInt32(key, 0x1b);
                                Marshal.WriteInt32(key, 8, 0);
                                var result = (IntPtr)callback.Invoke(window, new object[] { 0, new IntPtr(0x0100), key });
                                Check(result != IntPtr.Zero, "Hook must return suppression before revoking the connection");
                            }
                            finally { Marshal.FreeHGlobal(key); }
                            return;
                        }
                        throw new InvalidOperationException("Cannot find active stop window");
                    }
                    catch (Exception ex) { Console.Error.WriteLine(ex); Environment.Exit(1); }
                };
                lease.Acquire();
                Check(entered.WaitOne(2000), "Overlay must tick while control is held");
                lease.Release();
                throw new InvalidOperationException("A simultaneous release lost the emergency stop");
            }
        }

        static int RunChild(string desktopName, string mode)
        {
            string exe = typeof(DesktopLeaseTests).Assembly.Location;
            var startup = new StartupInfo { size = Marshal.SizeOf(typeof(StartupInfo)), desktop = desktopName };
            ProcessInfo info;
            if (!CreateProcess(exe, "\"" + exe + "\" " + mode, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero,
                null, ref startup, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                if (WaitForSingleObject(info.process, 10000) != 0)
                {
                    TerminateProcess(info.process, 1);
                    WaitForSingleObject(info.process, 1000);
                    throw new TimeoutException("Lease teardown stalled");
                }
                int exitCode;
                Check(GetExitCodeProcess(info.process, out exitCode), "Cannot read fixture exit code");
                return exitCode;
            }
            finally { CloseHandle(info.process); CloseHandle(info.thread); }
        }

        static int Main(string[] args)
        {
            try
            {
                if (args.Length > 0)
                {
                    if (args[0] == "stop") TestConcurrentStop();
                    else TestLease();
                    return 0;
                }
                string name = "AgentOS-Lease-Test-" + Guid.NewGuid().ToString("N");
                IntPtr desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x01FF, IntPtr.Zero);
                if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    Check(RunChild(name, "lease") == 0, "Lease lifecycle checks failed");
                    Check(RunChild(name, "stop") == 42, "Physical Escape must permanently revoke the connection");
                    return 0;
                }
                finally { CloseDesktop(desktop); }
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }
    }
}
