using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AgentOS.Computer
{
    internal static class WindowInputAccess
    {
        private const uint ProcessQueryLimitedInformation = 0x1000, TokenQuery = 0x0008;
        private const int TokenIntegrityLevel = 25, ErrorInsufficientBuffer = 122, ErrorAccessDenied = 5;
        private const uint WmGetFont = 0x0031;
        private const uint SmtoBlock = 1, SmtoAbortIfHung = 2, SmtoErrorOnExit = 0x20;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(SafeFileHandle token, int infoClass, IntPtr data, int size, out int used);
        [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam,
            uint flags, uint timeout, out UIntPtr result);

        private static uint IntegrityRid(IntPtr process)
        {
            SafeFileHandle token;
            if (!OpenProcessToken(process, TokenQuery, out token)) throw new Win32Exception();
            using (token)
            {
                int size;
                GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorInsufficientBuffer || size <= 0) throw new Win32Exception(error);
                var data = Marshal.AllocHGlobal(size);
                try
                {
                    if (!GetTokenInformation(token, TokenIntegrityLevel, data, size, out size)) throw new Win32Exception();
                    // TOKEN_MANDATORY_LABEL begins with SID_AND_ATTRIBUTES.Sid.
                    var sid = Marshal.ReadIntPtr(data);
                    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                    return unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1)));
                }
                finally { Marshal.FreeHGlobal(data); }
            }
        }

        public static object Inspect(string windowId)
        {
            uint pid;
            var hwnd = NativeDesktop.Resolve(windowId, out pid);
            using (var target = OpenProcess(ProcessQueryLimitedInformation, false, pid))
            {
                try
                {
                    if (target.IsInvalid) throw new Win32Exception();
                    uint targetRid = IntegrityRid(target.DangerousGetHandle());
                    uint callerRid = IntegrityRid(GetCurrentProcess());
                    NativeDesktop.Resolve(windowId);
                    return new { windowId = windowId, level = targetRid > callerRid ? "higher" : "compatible",
                        targetIntegrityRid = targetRid, callerIntegrityRid = callerRid };
                }
                catch (Win32Exception error)
                {
                    // A token DACL can also deny queries between peers. Test actual delivery of a
                    // read-only system message. A window can opt to allow it even across UIPI.
                    NativeDesktop.Resolve(windowId);
                    UIntPtr font;
                    SetLastError(0);
                    var delivered = SendMessageTimeoutW(hwnd, WmGetFont, UIntPtr.Zero, IntPtr.Zero,
                        SmtoBlock | SmtoAbortIfHung | SmtoErrorOnExit, 200, out font);
                    bool denied = delivered == IntPtr.Zero && Marshal.GetLastWin32Error() == ErrorAccessDenied;
                    NativeDesktop.Resolve(windowId);
                    return new { windowId = windowId, level = "unknown", messageAccessDenied = denied,
                        detail = "Cannot determine the process integrity levels (Win32 " + error.NativeErrorCode + "). " +
                            (denied ? "Windows also denied delivery of a read-only window message." :
                            "Use normal window control first.") };
                }
            }
        }
    }
}
