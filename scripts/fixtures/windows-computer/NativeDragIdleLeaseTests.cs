using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading;

namespace AgentOS.Computer
{
    // No mouse events or visible windows: the existing recorder runs on a private desktop.
    internal static class NativeDragIdleLeaseTests
    {
        const BindingFlags HiddenStatic = BindingFlags.NonPublic | BindingFlags.Static;
        static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
        static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0)
                {
                    string name = "AgentOS-Drag-Idle-Lease-" + Guid.NewGuid().ToString("N");
                    var fixture = typeof(DesktopLeaseTests);
                    var desktop = (IntPtr)fixture.GetMethod("CreateDesktop",HiddenStatic).Invoke(null,new object[] {name,IntPtr.Zero,IntPtr.Zero,(uint)0,(uint)0x01ff,IntPtr.Zero});
                    Check(desktop != IntPtr.Zero,"Cannot create the fixture desktop.");
                    try
                    {
                        int exit = (int)fixture.GetMethod("RunChild",HiddenStatic).Invoke(null,new object[] {name,"idle-drag"});
                        Check(exit == 0,"An idle lease handed off an unreleased owned mouse press.");
                        return 0;
                    }
                    finally { fixture.GetMethod("CloseDesktop",HiddenStatic).Invoke(null,new object[] {desktop}); }
                }

                // Install the real Program wiring, then emulate only the owned-press bookkeeping.
                // Never call SendInput, StopPointerInput or another mouse operation in this test.
                RuntimeHelpers.RunClassConstructor(typeof(Program).TypeHandle);
                var held = typeof(NativeDesktop).GetField("dragHeld",HiddenStatic);
                using (var lease = new DesktopLease(new Mutex(false)))
                {
                    lease.Acquire();
                    var idle = (Stopwatch)typeof(DesktopLease).GetField("idle",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(lease);
                    idle.Stop();
                    typeof(Stopwatch).GetField("elapsed",BindingFlags.NonPublic|BindingFlags.Instance).SetValue(idle,Stopwatch.Frequency*46L);
                    Check(idle.Elapsed > TimeSpan.FromSeconds(45),"Fixture clock did not expire the idle deadline.");
                    held.SetValue(null,true);
                    try
                    {
                        lease.ReleaseIfIdle();
                        Check(DesktopControlOverlay.Closes == 0,"Idle timeout closed the indicator while the drag press was still owned.");
                        Check((bool)typeof(DesktopLease).GetField("owned",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(lease),
                            "Idle timeout released the input mutex while the drag press was still owned.");
                    }
                    finally { held.SetValue(null,false); }
                    lease.ReleaseIfIdle();
                    Check(DesktopControlOverlay.Closes == 1,"A confirmed pointer release did not restore normal idle cleanup.");
                }
                Console.WriteLine("Verified expired idle lease retains its mutex and indicator until the owned drag press is released; no real input sent.");
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
    }
}
