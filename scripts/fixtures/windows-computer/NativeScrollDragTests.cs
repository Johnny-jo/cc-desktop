using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace AgentOS.Computer
{
    // This executable creates every input destination it uses. It never targets user windows.
    internal static class NativeScrollDragTests
    {
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static int wheel, horizontal, downs, ups;
        static Exception failure;
        static Dictionary<string, object> Args(params object[] pairs)
        {
            var result = new Dictionary<string, object>();
            for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i],pairs[i + 1]);
            return result;
        }
        static Dictionary<string, object> Data(object value) { return Json.Deserialize<Dictionary<string, object>>(Json.Serialize(value)); }
        static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
        static void Reject(Action action, string expected)
        {
            try { action(); } catch (Exception error) {
                Assert(error.Message.IndexOf(expected,StringComparison.OrdinalIgnoreCase) >= 0,
                    "Expected rejection " + expected + ", got " + error.Message); return;
            }
            throw new Exception("Expected rejection: " + expected);
        }
        static void Wait(Func<bool> reached)
        {
            for (int i = 0; i < 100 && !reached(); i++) Thread.Sleep(10);
            Assert(reached(),"Fixture did not receive the expected input.");
        }
        static IntPtr Hook(IntPtr hwnd, int msg, IntPtr wp, IntPtr lp, ref bool handled)
        {
            if (msg == 0x020a) Interlocked.Add(ref wheel,(short)(wp.ToInt64() >> 16));
            if (msg == 0x020e) Interlocked.Add(ref horizontal,(short)(wp.ToInt64() >> 16));
            if (msg == 0x0201) Interlocked.Increment(ref downs);
            if (msg == 0x0202) Interlocked.Increment(ref ups);
            return IntPtr.Zero;
        }
        static string Id(Window window)
        {
            return String.Format(CultureInfo.InvariantCulture,"{0:x}:{1}",new WindowInteropHelper(window).Handle.ToInt64(),Process.GetCurrentProcess().Id);
        }
        static void Run(string windowId, string otherId, int x, int y, int otherX, int otherY)
        {
            NativeDesktop.EnableDpiAwareness();
            using (var lease = new DesktopLease())
            {
                Program.Dispatch("activate_window",Args("windowId",windowId),lease);
                Func<string> observe = delegate { return (string)Data(Program.Dispatch("observe_target_tree",Args("windowId",windowId),lease))["observationId"]; };
                Func<string,Dictionary<string,object>> scroll = delegate(string observation) {
                    return Args("windowId",windowId,"observationId",observation,"x",x,"y",y,"deltaX",1,"deltaY",-2);
                };
                Func<string,Dictionary<string,object>> drag = delegate(string observation) {
                    return Args("windowId",windowId,"observationId",observation,"startX",x,"startY",y,"endX",x+80,"endY",y+40,"durationMs",100);
                };
                Reject(delegate { Program.Dispatch("scroll",scroll("missing"),lease); },"observation");
                string first = observe();
                var invalid = scroll(first); invalid["deltaY"] = 21;
                Reject(delegate { Program.Dispatch("scroll",invalid,lease); },"delta");
                invalid = scroll(observe()); invalid["deltaX"] = Double.NaN;
                Reject(delegate { Program.Dispatch("scroll",invalid,lease); },"delta");
                Program.Dispatch("scroll",scroll(observe()),lease);
                Wait(delegate { return wheel == -240 && horizontal == 120; });
                var consumed = scroll(observe());
                Program.Dispatch("scroll",consumed,lease);
                Reject(delegate { Program.Dispatch("scroll",consumed,lease); },"observation");
                int before = downs;
                var cross = drag(observe()); cross["endX"] = otherX; cross["endY"] = otherY;
                Reject(delegate { Program.Dispatch("drag",cross,lease); },"outside");
                var wrongWindow = drag(observe()); wrongWindow["windowId"] = otherId;
                Reject(delegate { Program.Dispatch("drag",wrongWindow,lease); },"observation");
                Assert(downs == before,"A rejected gesture pressed the mouse.");
                Program.Dispatch("drag",drag(observe()),lease);
                Wait(delegate { return downs == before + 1 && ups == downs; });
                Assert(GetAsyncKeyState(1) >= 0,"Successful drag held the left button.");

                var method = typeof(NativeDesktop).GetMethod("Drag",BindingFlags.Public|BindingFlags.Static);
                Assert(method != null,"Native drag operation is missing.");
                using (var cancel = new CancellationTokenSource())
                {
                    bool pressed = false;
                    Action<int,int,bool> stop = delegate(int px,int py,bool down) { if (down) { pressed = true; cancel.Cancel(); } };
                    try { method.Invoke(null,new object[] {windowId,x,y,x+80,y+40,100,stop,null,null,cancel.Token}); }
                    catch (TargetInvocationException error) { Assert(error.InnerException is OperationCanceledException,"Expected cooperative cancellation."); }
                    Assert(pressed,"The cancellation test never started a drag.");
                    Assert(GetAsyncKeyState(1) >= 0,"Cancelled drag held the left button.");
                }
                bool threw = false;
                try {
                    Action<int,int,bool> explode = delegate(int px,int py,bool down) { if (down) throw new InvalidOperationException("Fixture callback failed"); };
                    method.Invoke(null,new object[] {windowId,x,y,x+80,y+40,100,explode,null,null,CancellationToken.None});
                } catch (TargetInvocationException error) { threw = error.InnerException.Message == "Fixture callback failed"; }
                Assert(threw,"The exception test never reached its callback.");
                Assert(GetAsyncKeyState(1) >= 0,"Exceptional drag held the left button.");
                Exception contention = null;
                var contender = new Thread(delegate() {
                    using (var otherLease = new DesktopLease()) try {
                        Program.Dispatch("scroll",scroll("never-issued"),otherLease);
                    } catch (Exception error) { contention = error; }
                });
                contender.Start(); contender.Join();
                Assert(contention != null && contention.Message.Contains("owns desktop input"),"Input lease was not held across gestures.");
                Program.Dispatch("release_control",Args(),lease);
                Reject(delegate { Program.Dispatch("drag",drag(first),lease); },"observation");
                Program.Dispatch("release_control",Args(),lease);
                Reject(delegate { ScopedWindowBroker.ValidateRequest(windowId,true,"scroll",scroll("anything")); },"unavailable");
                Reject(delegate { ScopedWindowBroker.ValidateRequest(windowId,true,"drag",drag("anything")); },"unavailable");
                CheckCancellationProtocol(windowId,x,y,true);
                CheckCancellationProtocol(windowId,x,y,false);
            }
        }

        static void CheckCancellationProtocol(string windowId, int x, int y, bool marker)
        {
            using (var child = Process.Start(new ProcessStartInfo {
                FileName=Assembly.GetExecutingAssembly().Location,Arguments="helper " + Process.GetCurrentProcess().Id,
                UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,CreateNoWindow=true
            }))
            {
                try
                {
                    child.StandardInput.WriteLine(Json.Serialize(new {operation="observe_target_tree",args=Args("windowId",windowId)}));
                    child.StandardInput.Flush();
                    var reply = Data(Json.DeserializeObject(child.StandardOutput.ReadLine()));
                    Assert(reply.ContainsKey("value"),"Worker observation failed: " + Json.Serialize(reply));
                    var observed = (Dictionary<string,object>)reply["value"];
                    int before = downs;
                    child.StandardInput.WriteLine(Json.Serialize(new {operation="drag",args=Args("windowId",windowId,"observationId",observed["observationId"],
                        "startX",x,"startY",y,"endX",x+80,"endY",y+40,"durationMs",2000)}));
                    child.StandardInput.Flush();
                    Wait(delegate { return downs == before + 1; });
                    if (marker)
                    {
                        child.StandardInput.WriteLine("{\"operation\":\"cancel_current\",\"args\":{}}");
                        child.StandardInput.Flush();
                        var cancelled = Data(Json.DeserializeObject(child.StandardOutput.ReadLine()));
                        Assert(cancelled.ContainsKey("error") || (cancelled.ContainsKey("cancel_ack") && Object.Equals(cancelled["pointerReleased"],true)),
                            "Cancelled drag was reported as successful or its release was unconfirmed.");
                    }
                    else
                    {
                        child.StandardInput.Close();
                        Assert(child.WaitForExit(3000),"EOF did not release the mouse and stop the helper.");
                    }
                    Wait(delegate { return ups == downs; });
                    Assert(GetAsyncKeyState(1) >= 0,"Protocol cancellation held the left button.");
                }
                finally
                {
                    child.StandardInput.Close();
                    if (!child.WaitForExit(5000)) { child.Kill(); child.WaitForExit(); throw new Exception("Worker did not stop after EOF."); }
                }
            }
        }
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "helper")
                return (int)typeof(Program).GetMethod("Main",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[] {new[] {args[1]}});
            NativeDesktop.EnableDpiAwareness();
            var app = new Application();
            var other = new Window {Title="AgentOS drag fixture other",Width=320,Height=260,Left=500,Top=100,Content=new Border {Background=Brushes.Beige}};
            var window = new Window {Title="AgentOS scroll drag fixture",Width=360,Height=280,Left=100,Top=100,Content=new Border {Background=Brushes.White}};
            other.Show(); window.Show(); window.Activate();
            HwndSource.FromHwnd(new WindowInteropHelper(window).Handle).AddHook(Hook);
            var start = window.PointToScreen(new Point(60,80));
            var end = other.PointToScreen(new Point(60,80));
            string windowId = Id(window), otherId = Id(other);
            new Thread(delegate() {
                try { Thread.Sleep(200); Run(windowId,otherId,(int)start.X,(int)start.Y,(int)end.X,(int)end.Y); }
                catch (Exception error) { failure = error; }
                finally { app.Dispatcher.BeginInvoke(new Action(delegate { window.Close(); other.Close(); app.Shutdown(); })); }
            }) {IsBackground=true}.Start();
            app.Run();
            if (failure != null) { Console.Error.WriteLine(failure); return 1; }
            Console.WriteLine("Verified wheel axes, same-window drag, stale/cross-window rejection, lease contention and cancellation/exception mouse release.");
            return 0;
        }
    }
}
