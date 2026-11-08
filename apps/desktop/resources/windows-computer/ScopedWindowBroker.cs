using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AgentOS.Computer
{
    // Only the relay has model-facing stdio. The elevated process independently authorizes
    // the live target and enforces the operation policy at the point of dispatch.
    internal static class ScopedWindowBroker
    {
        const string RelayMode = "--authorize-window", WorkerMode = "--window-worker";
        const string PipePrefix = "AgentOS.Window.";
        const uint QueryProcess = 0x1000, Synchronize = 0x100000, WaitTimeout = 258;
        static readonly Encoding Utf8 = new UTF8Encoding(false, true);
        static readonly string Image = Assembly.GetExecutingAssembly().Location;

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern SafeWaitHandle OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")]
        static extern uint WaitForSingleObject(SafeWaitHandle process, uint milliseconds);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool QueryFullProcessImageName(SafeWaitHandle process, uint flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(int pid, out uint session);
        [DllImport("kernel32.dll")] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll")] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll")] static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
        [DllImport("kernel32.dll")] static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint session);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(SafeWaitHandle process, uint access, out SafeWaitHandle token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(SafeWaitHandle token, int infoClass, out int value, int length, out int returned);

        [StructLayout(LayoutKind.Sequential)]
        struct ProcessBasicInfo { public IntPtr ExitStatus, Peb, Affinity, Priority, Pid, ParentPid; }
        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out ProcessBasicInfo info, int length, out int returned);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr GetProp(IntPtr hwnd, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr RemoveProp(IntPtr hwnd, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int MessageBox(IntPtr owner, string text, string caption, uint type);

        static int CurrentPid { get { using (var self = Process.GetCurrentProcess()) return self.Id; } }

        internal static SafeWaitHandle PinProcess(int pid)
        {
            uint local, peer;
            if (!ProcessIdToSessionId(CurrentPid, out local) || !ProcessIdToSessionId(pid, out peer) || peer != local)
                throw new InvalidOperationException("The process is outside the current Windows session.");
            var process = OpenProcess(QueryProcess | Synchronize, false, pid);
            if (process.IsInvalid) { process.Dispose(); throw new InvalidOperationException("The Windows process is unavailable."); }
            return process;
        }

        static bool IsActualParent(int pid)
        {
            ProcessBasicInfo info;
            int size;
            return NtQueryInformationProcess(new IntPtr(-1), 0, out info, Marshal.SizeOf(typeof(ProcessBasicInfo)), out size) == 0 &&
                info.ParentPid.ToInt64() == pid;
        }

        static bool Elevated(SafeWaitHandle process)
        {
            SafeWaitHandle token;
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            using (token)
            {
                int elevated, size;
                if (!GetTokenInformation(token, 20, out elevated, sizeof(int), out size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return elevated != 0;
            }
        }

        internal static bool CanRunNormal(int parentPid)
        {
            // A direct runas launch cannot turn the unscoped stdio mode into a privileged relay.
            try
            {
                using (var self = PinProcess(CurrentPid)) if (!Elevated(self)) return true;
                if (!IsActualParent(parentPid)) return false;
                using (var parent = PinProcess(parentPid)) return Elevated(parent);
            }
            catch { return false; }
        }

        static string ProcessImage(SafeWaitHandle process)
        {
            int size = 32768;
            var path = new StringBuilder(size);
            if (!QueryFullProcessImageName(process, 0, path, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return path.ToString();
        }

        internal static void VerifyPeer(SafePipeHandle pipe, bool client, int expectedPid)
        {
            uint pid, session, local;
            if (!(client ? GetNamedPipeClientProcessId(pipe, out pid) : GetNamedPipeServerProcessId(pipe, out pid)) ||
                pid != expectedPid || !ProcessIdToSessionId(CurrentPid, out local) ||
                !(client ? GetNamedPipeClientSessionId(pipe, out session) : GetNamedPipeServerSessionId(pipe, out session)) ||
                session != local) throw new InvalidOperationException("The window authorization pipe peer could not be verified.");
        }

        internal static NamedPipeServerStream CreatePipe(string nonce)
        {
            var acl = new PipeSecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                PipeAccessRights.FullControl, AccessControlType.Deny));
            using (var identity = WindowsIdentity.GetCurrent())
                acl.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            // A standard Windows user can approve UAC with a different local administrator account.
            // That worker must still prove its PID and session on this single local pipe instance.
            acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                PipeAccessRights.ReadWrite, AccessControlType.Allow));
            return new NamedPipeServerStream(PipePrefix + nonce, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, acl);
        }

        internal static NamedPipeClientStream OpenWorkerPipe(string nonce)
        {
            return new NamedPipeClientStream(".", PipePrefix + nonce, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None);
        }

        // Keep cancellation independent of ShellExecute, the modal consent dialog and UIA providers.
        // Higher-integrity workers terminate themselves. Neither peer needs PROCESS_TERMINATE on the other.
        internal static void WatchParent(SafeWaitHandle parent)
        {
            var thread = new Thread(delegate() {
                if (WaitForSingleObject(parent, UInt32.MaxValue) != WaitTimeout) Environment.Exit(0);
            }) { IsBackground = true };
            thread.Start();
        }

        static string RequestLine(TextReader input)
        {
            var line = new StringBuilder();
            int ch;
            while ((ch = input.Read()) >= 0)
            {
                if (ch == '\n') return line.ToString();
                if (line.Length == 65536) throw new ArgumentException("Window request exceeds the size limit.");
                line.Append((char)ch);
            }
            return null;
        }

        sealed class Requests : IDisposable
        {
            readonly BlockingCollection<string> lines = new BlockingCollection<string>(1);
            int outstanding;
            volatile bool closing;

            public Requests(TextReader input, bool initialPending)
            {
                outstanding = initialPending ? 1 : 0;
                new Thread(delegate() {
                    try
                    {
                        string line;
                        while ((line = RequestLine(input)) != null)
                        {
                            // A second command (including release during a blocked action) retires the
                            // grant. Never queue a later click behind an action whose result is unknown.
                            if (Interlocked.Exchange(ref outstanding, 1) != 0) break;
                            lines.Add(line);
                        }
                    }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                    catch (ArgumentException) { }
                    if (!closing) Environment.Exit(0);
                }) { IsBackground = true }.Start();
            }

            public string Take() { return lines.Take(); }
            public void Respond(TextWriter output, string reply)
            {
                Interlocked.Exchange(ref outstanding, 0);
                output.WriteLine(reply);
            }
            public void Dispose() { closing = true; }
        }

        internal static void ValidateRequest(string target, bool authorized, string operation, IDictionary<string, object> args)
        {
            if (!authorized && operation != "authorize_window")
                throw new InvalidOperationException("This window must be authorized before use.");
            switch (operation)
            {
                case "authorize_window":
                    if (authorized) throw new InvalidOperationException("This grant is already active.");
                    break;
                case "finish_visual": case "release_control":
                    if (!args.ContainsKey("windowId")) return;
                    break;
                case "capture_window": case "observe_window": case "observe_target_tree":
                case "activate_window": case "click": case "invoke_control": case "select_item": case "finish_pointer":
                    break;
                default: throw new InvalidOperationException("This operation is unavailable under a window grant.");
            }
            if (!String.Equals(Program.Field(args, "windowId"), target, StringComparison.Ordinal))
                throw new InvalidOperationException("This grant belongs to a different window.");
        }

        static int TargetPid(string id)
        {
            string[] parts = id.Split(':');
            long hwnd;
            int pid;
            if (parts.Length != 2 || parts[0].Length > 16 ||
                !Int64.TryParse(parts[0], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out hwnd) || hwnd <= 0 ||
                !Int32.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid <= 0 ||
                !String.Equals(id, hwnd.ToString("x", CultureInfo.InvariantCulture) + ":" + pid.ToString(CultureInfo.InvariantCulture),
                    StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Invalid target windowId.");
            return pid;
        }

        static int RunRelay(int parentPid, string target)
        {
            TargetPid(target);
            if (!IsActualParent(parentPid)) throw new InvalidOperationException("The requesting process is unavailable.");
            using (var parent = PinProcess(parentPid))
            {
                WatchParent(parent);
                string first = RequestLine(Console.In);
                if (first == null) return 0;
                IDictionary<string, object> args;
                string operation = Program.ParseRequest(first, out args);
                ValidateRequest(target, false, operation, args);
                NativeDesktop.Resolve(target);
                string nonce = Guid.NewGuid().ToString("N");
                using (var requests = new Requests(Console.In, true))
                using (var pipe = CreatePipe(nonce))
                {
                    var start = new ProcessStartInfo {
                        FileName = Image, WorkingDirectory = Path.GetDirectoryName(Image),
                        Arguments = WorkerMode + " " + CurrentPid.ToString(CultureInfo.InvariantCulture) + " " + nonce + " " + target,
                        UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden
                    };
                    using (var worker = Process.Start(start))
                    {
                        if (worker == null) throw new InvalidOperationException("Windows did not start the authorization helper.");
                        var connected = pipe.BeginWaitForConnection(null, null);
                        using (var ready = connected.AsyncWaitHandle)
                        {
                            var timeout = Stopwatch.StartNew();
                            while (!ready.WaitOne(100)) if (worker.HasExited || timeout.ElapsedMilliseconds >= 10000)
                                throw new InvalidOperationException("The authorization helper did not connect.");
                            pipe.EndWaitForConnection(connected);
                        }
                        return Forward(pipe, worker, first, requests.Take, reply => requests.Respond(Console.Out, reply));
                    }
                }
            }
        }

        internal static int Forward(NamedPipeServerStream pipe, Process worker, string first, Func<string> next, Action<string> respond)
        {
            VerifyPeer(pipe.SafePipeHandle, true, worker.Id);
            using (var input = new StreamReader(pipe, Utf8, false, 4096, true))
            using (var output = new StreamWriter(pipe, Utf8, 4096, true) { AutoFlush = true })
            {
                output.WriteLine(first);
                // Reading replies continuously also propagates physical Esc between requests.
                new Thread(delegate() {
                    try { while (true) output.WriteLine(next()); }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                }) { IsBackground = true }.Start();
                string reply;
                while ((reply = input.ReadLine()) != null) respond(reply);
            }
            return worker.WaitForExit(5000) ? worker.ExitCode : 1;
        }

        sealed class WindowGrant : IDisposable
        {
            readonly string target, marker = PipePrefix + Guid.NewGuid().ToString("N");
            readonly SafeWaitHandle process;
            readonly IntPtr hwnd;
            readonly IntPtr cookie = new IntPtr(1);
            readonly Timer timer;
            long deadline;

            public WindowGrant(string target)
            {
                this.target = target;
                process = PinProcess(TargetPid(target));
                try
                {
                    hwnd = NativeDesktop.Resolve(target);
                    // Window properties disappear with the HWND even when Windows later recycles the
                    // same numeric handle inside the same still-running process.
                    if (!SetProp(hwnd, marker, cookie)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    AppDomain.CurrentDomain.ProcessExit += OnExit;
                    NativeDesktop.ValidateScopedHandle = CheckHandle;
                    Validate();
                    deadline = Stopwatch.GetTimestamp() + 120 * Stopwatch.Frequency;
                    timer = new Timer(delegate {
                        if (!Alive || Stopwatch.GetTimestamp() >= Interlocked.Read(ref deadline)) Environment.Exit(0);
                    }, null, 250, 250);
                }
                catch { Dispose(); throw; }
            }

            bool Alive { get { return WaitForSingleObject(process, 0) == WaitTimeout && GetProp(hwnd, marker) == cookie; } }
            void CheckHandle(IntPtr resolved)
            {
                if (resolved != hwnd || !Alive)
                    throw new InvalidOperationException("The authorized window changed or closed. Request a new grant.");
            }
            public void Validate() { NativeDesktop.Resolve(target); }
            public void NoteActivity() { Interlocked.Exchange(ref deadline, Stopwatch.GetTimestamp() + 75 * Stopwatch.Frequency); }

            static string DisplayText(string value, int max)
            {
                var text = new StringBuilder();
                foreach (char ch in value)
                {
                    if (text.Length == max) { text.Append('…'); break; }
                    // Keep window-controlled line breaks and bidi controls out of the security dialog.
                    var category = Char.GetUnicodeCategory(ch);
                    if (Char.IsControl(ch) || category == UnicodeCategory.Format ||
                        category == UnicodeCategory.LineSeparator || category == UnicodeCategory.ParagraphSeparator) text.Append(' ');
                    else text.Append(ch);
                }
                return text.ToString();
            }

            public void Confirm()
            {
                var title = new StringBuilder(256);
                GetWindowText(hwnd, title, title.Capacity);
                var message = "允许 CC Desktop 的当前会话临时以管理员权限操作此窗口？\n\n" +
                    "窗口编号：" + target + "\n程序：" + DisplayText(ProcessImage(process), 768) +
                    "\n窗口标题：" + DisplayText(title.ToString(), 140) +
                    "\n\n允许读取此窗口的控件和图像、激活窗口、点击及操作控件。操作可能更改该程序的管理员设置。" +
                    "\n按 Esc 可立即停止。释放控制、连接结束、窗口关闭或空闲超时后，授权失效。";
                // MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST
                if (MessageBox(IntPtr.Zero, message, "CC Desktop · 授权控制管理员窗口", 0x50131) != 1)
                    throw new OperationCanceledException("用户取消了此窗口的管理员控制授权。");
                Validate();
            }

            void OnExit(object sender, EventArgs e) { RemoveMarker(); }
            void RemoveMarker() { if (hwnd != IntPtr.Zero && GetProp(hwnd, marker) == cookie) RemoveProp(hwnd, marker); }
            public void Dispose()
            {
                if (timer != null) using (var drained = new ManualResetEvent(false))
                    if (timer.Dispose(drained)) drained.WaitOne();
                NativeDesktop.ValidateScopedHandle = null;
                AppDomain.CurrentDomain.ProcessExit -= OnExit;
                RemoveMarker();
                process.Dispose();
            }
        }

        static int RunWorker(int relayPid, string nonce, string target)
        {
            Guid token;
            if (!Guid.TryParseExact(nonce, "N", out token)) return 2;
            TargetPid(target);
            using (var self = PinProcess(CurrentPid)) if (!Elevated(self)) return 2;
            using (var relay = PinProcess(relayPid))
            using (var pipe = OpenWorkerPipe(nonce))
            {
                if (!String.Equals(ProcessImage(relay), Image, StringComparison.OrdinalIgnoreCase)) return 2;
                WatchParent(relay);
                pipe.Connect(5000);
                VerifyPeer(pipe.SafePipeHandle, false, relayPid);
                using (var input = new StreamReader(pipe, Utf8, false, 4096, true))
                using (var output = new StreamWriter(pipe, Utf8, 4096, true) { AutoFlush = true })
                using (var requests = new Requests(input, false))
                {
                    try
                    {
                        NativeDesktop.EnableDpiAwareness();
                        using (var grant = new WindowGrant(target))
                        using (var lease = new DesktopLease())
                        {
                            IDictionary<string, object> args;
                            string op = Program.ParseRequest(requests.Take(), out args);
                            ValidateRequest(target, false, op, args);
                            grant.Confirm();
                            lease.Acquire(); // Physical Esc remains armed even while a UIA call is blocked.
                            grant.Validate();
                            grant.NoteActivity();
                            requests.Respond(output, Program.Reply(new { authorized = true, windowId = target }));
                            while (true)
                            {
                                string line = requests.Take();
                                grant.Validate();
                                bool release = false;
                                try
                                {
                                    op = Program.ParseRequest(line, out args);
                                    ValidateRequest(target, true, op, args);
                                    grant.NoteActivity();
                                    release = op == "release_control";
                                    object value = Program.Dispatch(op, args, lease);
                                    if (!release) grant.Validate();
                                    requests.Respond(output, Program.Reply(value));
                                    grant.NoteActivity();
                                }
                                catch (Exception error) { requests.Respond(output, Program.Error(error)); }
                                if (release) return 0;
                            }
                        }
                    }
                    catch (Exception error) { output.WriteLine(Program.Error(error)); return 1; }
                }
            }
        }

        internal static int Run(string[] args)
        {
            int pid;
            if (args.Length < 3 || !Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid <= 0)
                return 2;
            try
            {
                if (args[0] == RelayMode && args.Length == 3) return RunRelay(pid, args[2]);
                if (args[0] == WorkerMode && args.Length == 4) return RunWorker(pid, args[2], args[3]);
                return 2;
            }
            catch (Exception error)
            {
                if (args[0] == RelayMode)
                {
                    var native = error as Win32Exception;
                    if (native != null && native.NativeErrorCode == 1223)
                        error = new OperationCanceledException("用户取消了 Windows UAC 授权。");
                    Console.WriteLine(Program.Error(error));
                }
                return 1;
            }
        }
    }
}
