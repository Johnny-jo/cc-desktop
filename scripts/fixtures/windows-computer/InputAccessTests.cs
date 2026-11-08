using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Web.Script.Serialization;
using AgentOS.Computer;

internal static class InputAccessTests
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowEx(uint exStyle, string cls, string title, uint style, int x, int y, int w, int h,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, byte[] descriptor);

    static void Expect(string id, string level, bool messageDenied)
    {
        var json = new JavaScriptSerializer();
        var result = json.Deserialize<Dictionary<string, object>>(json.Serialize(WindowInputAccess.Inspect(id)));
        if (!Equals(result["windowId"], id) || !Equals(result["level"], level) ||
            (result.ContainsKey("messageAccessDenied") && Equals(result["messageAccessDenied"], true)) != messageDenied)
            throw new Exception("Unexpected access check: " + json.Serialize(result));
    }

    static void Main()
    {
        // This desktop is never switched to. The process and window below exist only in this test.
        var desktop = CreateDesktop("AgentOS-Access-" + Guid.NewGuid().ToString("N"), IntPtr.Zero, IntPtr.Zero,
            0, 0x1ff, IntPtr.Zero);
        if (desktop == IntPtr.Zero || !SetThreadDesktop(desktop)) throw new Win32Exception();
        var hwnd = CreateWindowEx(0, "STATIC", "test", 0x90000000, 0, 0, 10, 10, IntPtr.Zero,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) throw new Win32Exception();
        var id = String.Format("{0:x}:{1}", hwnd.ToInt64(), Process.GetCurrentProcess().Id);
        Expect(id, "compatible", false);

        // Refuse PROCESS_QUERY_LIMITED_INFORMATION on this test process. Window messages still work.
        var sd = new RawSecurityDescriptor("D:(D;;0x1000;;;WD)(A;;GA;;;WD)");
        var bytes = new byte[sd.BinaryLength];
        sd.GetBinaryForm(bytes, 0);
        if (!SetKernelObjectSecurity(GetCurrentProcess(), 4, bytes)) throw new Win32Exception();
        Expect(id, "unknown", false);

        DestroyWindow(hwnd);
        try { WindowInputAccess.Inspect(id); }
        catch (InvalidOperationException) { return; }
        throw new Exception("Closed window accepted by the input preflight.");
    }
}
