using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

namespace AgentOS.Computer
{
    // The request thread owns the mutex. The STA keeps both stop keys and the
    // indicator responsive even when an accessibility provider blocks a request.
    internal sealed class DesktopLease : IDisposable
    {
        const int WmKeyDown = 0x0100, WmSysKeyDown = 0x0104;
        const int WmKeyUp = 0x0101, WmSysKeyUp = 0x0105;
        const int InjectedKey = 0x10; // LLKHF_INJECTED, including the helper's SendInput
        const uint AllInput = 0x04FF, InputAvailable = 0x0004; // QS_ALLINPUT, MWMO_INPUTAVAILABLE
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint MsgWaitForMultipleObjectsEx(uint count, ref IntPtr handle, uint timeout, uint mask, uint flags);

        internal static bool SuppressEscape(int message, int key, int flags, ref bool stopping)
        {
            if (key != (int)Keys.Escape || (flags & InjectedKey) != 0) return false;
            if (message == WmKeyDown || message == WmSysKeyDown) stopping = true;
            else if (message != WmKeyUp && message != WmSysKeyUp) return false;
            return stopping;
        }

        sealed class StopWindow : NativeWindow, IDisposable
        {
            const int HotkeyId = 410, WmHotkey = 0x0312, WhKeyboardLl = 13;
            delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
            [DllImport("user32.dll", SetLastError = true)]
            static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
            [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window, int id);
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
            static extern IntPtr GetModuleHandle(string name);
            [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            static extern IntPtr SetWindowsHookEx(int type, KeyboardProc callback, IntPtr module, uint thread);
            [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
            [DllImport("user32.dll")]
            static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);

            readonly KeyboardProc keyboardProc;
            IntPtr hook;
            bool registered, stopping;
            public bool Stopping { get { return stopping; } }

            public StopWindow()
            {
                keyboardProc = OnKeyboard;
                try
                {
                    CreateHandle(new CreateParams { Parent = new IntPtr(-3) }); // HWND_MESSAGE
                    registered = RegisterHotKey(Handle, HotkeyId, 0x4003, (uint)Keys.F10);
                    if (!registered) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot reserve Ctrl+Alt+F10 for stopping desktop control.");
                    hook = SetWindowsHookEx(WhKeyboardLl, keyboardProc, GetModuleHandle(null), 0);
                    if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot listen for physical Esc to stop desktop control.");
                }
                catch { Dispose(); throw; }
            }

            IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
            {
                // vkCode and flags are DWORDs at offsets 0 and 8 in KBDLLHOOKSTRUCT.
                // Return to Windows before exiting, so the target never gets this key-down.
                if (code == 0 && SuppressEscape(message.ToInt32(), Marshal.ReadInt32(data), Marshal.ReadInt32(data, 8), ref stopping))
                    return new IntPtr(1);
                return CallNextHookEx(IntPtr.Zero, code, message, data);
            }

            protected override void WndProc(ref Message message)
            {
                if (message.Msg == WmHotkey && message.WParam.ToInt32() == HotkeyId) stopping = true;
                base.WndProc(ref message);
            }

            public void Dispose()
            {
                if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
                if (registered) UnregisterHotKey(Handle, HotkeyId);
                if (Handle != IntPtr.Zero) DestroyHandle();
                if (stopping) Environment.Exit(42); // A key consumed during teardown must still revoke the connection.
            }
        }

        readonly Mutex mutex;
        readonly Stopwatch idle = new Stopwatch();
        readonly ManualResetEvent ending = new ManualResetEvent(false);
        readonly AutoResetEvent ready = new AutoResetEvent(false);
        readonly object pointerLock = new object();
        Thread hotkeyThread;
        Exception startupError;
        bool owned, analyzingFrame;
        volatile bool showControl;
        int pointerX, pointerY;
        bool pointerPending, pointerPressed;

        static Mutex OpenInputMutex()
        {
            // A standard helper keeps this object alive while an administrator
            // from the same interactive session takes over the approved window.
            const string name = @"Local\AgentOS.WindowsComputer.Input";
            const MutexRights use = MutexRights.Synchronize | MutexRights.Modify;
            try { return Mutex.OpenExisting(name, use); }
            catch (WaitHandleCannotBeOpenedException) { }
            var acl = new MutexSecurity();
            using (var identity = WindowsIdentity.GetCurrent())
                acl.AddAccessRule(new MutexAccessRule(identity.User, MutexRights.FullControl, AccessControlType.Allow));
            acl.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                use, AccessControlType.Allow));
            bool created;
            try { return new Mutex(false, name, out created, acl); }
            catch (UnauthorizedAccessException) { return Mutex.OpenExisting(name, use); }
        }
        public DesktopLease() : this(OpenInputMutex()) { }
        internal DesktopLease(Mutex mutex) { this.mutex = mutex; }

        public void MovePointer(int x, int y, bool pressed)
        {
            if (!showControl) return;
            lock (pointerLock)
            {
                pointerX = x;
                pointerY = y;
                pointerPressed |= pressed;
                pointerPending = true;
            }
        }

        void UpdatePointer(DesktopControlOverlay overlay)
        {
            int x, y;
            bool pressed;
            lock (pointerLock)
            {
                if (!pointerPending) return;
                x = pointerX;
                y = pointerY;
                pressed = pointerPressed;
                pointerPending = pointerPressed = false;
            }
            overlay.MovePointer(x, y, pressed);
        }

        void RunMonitor()
        {
            // Release joins this thread before disposing the event.
            IntPtr endHandle = ending.SafeWaitHandle.DangerousGetHandle();
            bool initializing = true;
            try
            {
                using (var window = new StopWindow())
                {
                    DesktopControlOverlay overlay = null;
                    try
                    {
                        while (true)
                        {
                            Application.DoEvents();
                            if (window.Stopping) Environment.Exit(42);
                            if (ending.WaitOne(0)) break;
                            if (showControl && overlay == null)
                            {
                                initializing = true; // Initial control or a read-only frame promoted to control.
                                overlay = new DesktopControlOverlay();
                                overlay.Show();
                            }
                            if (initializing) { initializing = false; ready.Set(); }
                            if (overlay != null) { UpdatePointer(overlay); overlay.Tick(); }
                            // Render the next animation tick or wake immediately for keyboard hooks and shutdown.
                            if (MsgWaitForMultipleObjectsEx(1, ref endHandle, 16, AllInput, InputAvailable) == UInt32.MaxValue)
                                throw new Win32Exception(Marshal.GetLastWin32Error());
                        }
                    }
                    finally { if (overlay != null) overlay.Dispose(); }
                }
            }
            catch (Exception ex)
            {
                if (!initializing) Environment.Exit(42); // An active connection has lost its stop handler or indicator.
                startupError = ex;
                ready.Set();
            }
        }

        public void Acquire() { Acquire(true); }

        void Acquire(bool control)
        {
            idle.Restart();
            if (owned)
            {
                if (!control || showControl) return;
                showControl = true;
            }
            else
            {
                try { owned = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned) throw new InvalidOperationException("Another AgentOS session owns desktop input. Wait for release_control.");
                try
                {
                    ending.Reset();
                    startupError = null;
                    showControl = control;
                    var thread = new Thread(RunMonitor) { IsBackground = true };
                    thread.SetApartmentState(ApartmentState.STA);
                    thread.Start();
                    hotkeyThread = thread;
                }
                catch { Release(); throw; }
            }
            ready.WaitOne();
            if (startupError != null) { Release(); throw startupError; }
        }

        public void NoteActivity() { if (owned) idle.Restart(); }

        public void ReleaseIfIdle()
        {
            // The bridge finishes the frame after OCR. Its deadline covers both
            // capture and inference; control otherwise survives normal agent think time.
            if (owned && idle.Elapsed >= TimeSpan.FromSeconds(analyzingFrame ? 75 : 45)) Release();
        }

        public void BeginFrame()
        {
            // A first, read-only capture reserves the stop keys through OCR.
            // It creates no indicator and leaves an existing control indicator in place.
            Acquire(false);
            analyzingFrame = true;
        }

        public void EndFrame()
        {
            if (!analyzingFrame) return;
            analyzingFrame = false;
            if (showControl) idle.Restart();
            else Release();
        }

        public void Release()
        {
            analyzingFrame = false;
            if (!owned) return;
            ending.Set();
            if (hotkeyThread != null) { hotkeyThread.Join(); hotkeyThread = null; }
            showControl = false;
            lock (pointerLock) { pointerPending = pointerPressed = false; }
            mutex.ReleaseMutex();
            owned = false;
        }

        public void Dispose() { Release(); ready.Dispose(); ending.Dispose(); mutex.Dispose(); }
    }
}
