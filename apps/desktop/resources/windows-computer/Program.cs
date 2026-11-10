using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace AgentOS.Computer
{
    // The helper is a private child of one MCP connection. stdout is JSONL.
    internal static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly JavaScriptSerializer ReplyJson = new JavaScriptSerializer {
            MaxJsonLength = 4 * ((VisualDesktop.MaxPngBytes + 2) / 3) + 4096
        };
        static readonly AutomationDesktop Automation = new AutomationDesktop();
        static readonly VisualDesktop Visual = new VisualDesktop();
        static Program()
        {
            DesktopLease.BeforeStop = delegate { while (!NativeDesktop.StopPointerInput()) Thread.Sleep(100); };
            DesktopLease.CanReleaseIdle = delegate { return !NativeDesktop.HasOwnedPointer; };
        }

        internal static string Field(IDictionary<string, object> data, string key, bool required = true)
        {
            object value;
            if (data.TryGetValue(key, out value) && value is string) return (string)value;
            if (!required) return null;
            throw new ArgumentException("Expected a string for " + key);
        }

        static int Integer(IDictionary<string, object> data, string key, int? fallback = null)
        {
            object value;
            if (!data.TryGetValue(key,out value) && fallback.HasValue) return fallback.Value;
            if (value is int) return (int)value;
            throw new ArgumentException("Expected an integer for " + key);
        }

        internal static object Dispatch(string op, IDictionary<string, object> a, DesktopLease lease,
            CancellationToken cancellation = default(CancellationToken))
        {
            if (op == "list_windows") return NativeDesktop.ListWindows();
            if (op == "finish_pointer") { NativeDesktop.FinishPointer(); return new { finished = true }; }
            if (op == "list_displays") return VisualDesktop.ListDisplays();
            if (op == "finish_visual") { lease.EndFrame(); return new { finished = true }; }
            if (op == "capture_window" || op == "capture_display")
            {
                lease.BeginFrame(); // Register the emergency stop even for the first, read-only operation.
                try
                {
                    if (op == "capture_window") return Visual.Capture(Field(a, "windowId"), a);
                    string display = Field(a, "displayId", false);
                    if (a.ContainsKey("windowId")) return Visual.CaptureVisibleDisplay(display, Field(a, "windowId"), a);
                    Visual.Clear();
                    return VisualDesktop.CaptureDisplay(display, a);
                }
                catch { lease.EndFrame(); throw; }
            }
            if (op == "release_control") { Visual.Clear(); Automation.Clear(); NativeDesktop.RequirePointerReleased(); lease.Release(); return new { released = true }; }
            string window = Field(a, "windowId");
            if (op == "input_access") return WindowInputAccess.Inspect(window);
            if (op == "observe_window") return Automation.Observe(window, Field(a, "cursor", false));
            if (op == "observe_target_tree") return Automation.ObserveTargetTree(window,
                a.ContainsKey("cursor") ? Field(a, "cursor") : null,
                a.ContainsKey("extendObservationId") ? Field(a, "extendObservationId") : null);

            lease.Acquire();
            switch (op)
            {
                case "activate_window": return NativeDesktop.Activate(window);
                case "invoke_control":
                case "set_value":
                case "select_item":
                    string action = op == "invoke_control" ? "invoke" : op == "set_value" ? "setValue" : "select";
                    return Automation.Act(window, Field(a, "observationId"), Field(a, "controlId"), action,
                        Field(a, "value", op == "set_value"), lease.MovePointer);
                case "click":
                    string observation = Field(a, "observationId");
                    int x = Convert.ToInt32(a["x"]), y = Convert.ToInt32(a["y"]);
                    string button = Field(a, "button");
                    if (VisualDesktop.IsVisualId(observation))
                    {
                        System.Drawing.Rectangle? label = null;
                        object raw;
                        if (a.TryGetValue("targetBounds", out raw))
                        {
                            var rect = raw as IDictionary<string, object>;
                            if (rect == null || !new[] {"x","y","width","height"}.All(k => rect.ContainsKey(k) && rect[k] is int))
                                throw new ArgumentException("Invalid observation label bounds.");
                            label = new System.Drawing.Rectangle((int)rect["x"], (int)rect["y"], (int)rect["width"], (int)rect["height"]);
                        }
                        object requirePointer;
                        return Visual.Click(window, observation, x, y, button, lease.MovePointer, label,
                            a.TryGetValue("requirePointerAtTarget", out requirePointer) && Object.Equals(requirePointer, true));
                    }
                    Automation.ValidateObservation(window, observation);
                    return NativeDesktop.Click(window, x, y, button, lease.MovePointer,
                        delegate { Automation.ValidateObservation(window, observation); });
                case "scroll":
                case "drag":
                    try
                    {
                        string pointerObservation = Field(a,"observationId");
                        int startX = Integer(a,op == "scroll" ? "x" : "startX");
                        int startY = Integer(a,op == "scroll" ? "y" : "startY");
                        int endX = op == "scroll" ? startX : Integer(a,"endX");
                        int endY = op == "scroll" ? startY : Integer(a,"endY");
                        Action validate, geometry;
                        if (VisualDesktop.IsVisualId(pointerObservation))
                        {
                            validate = Visual.ValidatePointerObservation(window,pointerObservation,startX,startY,endX,endY);
                            geometry = delegate { Visual.ValidatePointerGeometry(window,pointerObservation); };
                        }
                        else
                        {
                            validate = delegate { Automation.ValidateObservation(window,pointerObservation); };
                            geometry = validate;
                        }
                        // Validate before any pointer move; native input rechecks immediately before pressing.
                        validate();
                        if (op == "scroll") return NativeDesktop.Scroll(window,startX,startY,Integer(a,"deltaX",0),Integer(a,"deltaY",0),lease.MovePointer,validate);
                        return NativeDesktop.Drag(window,startX,startY,endX,endY,Integer(a,"durationMs",500),lease.MovePointer,validate,geometry,cancellation);
                    }
                    finally { Visual.Clear(); Automation.Clear(); }
                case "type_text": return NativeDesktop.TypeText(window, Field(a, "text"));
                case "shortcut":
                    var keys = ((IEnumerable)a["keys"]).Cast<string>().ToArray();
                    return NativeDesktop.Shortcut(window, keys);
                default: throw new ArgumentException("Unknown operation.");
            }
        }

        internal static string ParseRequest(string line, out IDictionary<string, object> args)
        {
            var data = Json.Deserialize<Dictionary<string, object>>(line);
            args = (IDictionary<string, object>)data["args"];
            if (args == null) throw new ArgumentException("Expected operation arguments.");
            return Field(data, "operation");
        }

        internal static string Reply(object value) { return ReplyJson.Serialize(new { value = value }); }

        internal static string Error(Exception error)
        {
            string code = error.Data["code"] as string;
            return code == null ? ReplyJson.Serialize(new { error = error.Message }) :
                ReplyJson.Serialize(new { error = error.Message, errorCode = code });
        }

        [MTAThread]
        static int Main(string[] args)
        {
            int parentId;
            if (args.Length == 0 || args[0] != "--window-worker")
            {
                Console.InputEncoding = new UTF8Encoding(false);
                Console.OutputEncoding = new UTF8Encoding(false);
            }
            if (args.Length > 0 && args[0].StartsWith("--", StringComparison.Ordinal))
                return ScopedWindowBroker.Run(args);
            if (args.Length != 1 || !Int32.TryParse(args[0], out parentId)) return 2;
            if (!ScopedWindowBroker.CanRunNormal(parentId)) return 2;
            using (var parent = Process.GetProcessById(parentId))
            using (var lease = new DesktopLease())
            using (var input = new BlockingCollection<PendingInput>())
            {
                parent.EnableRaisingEvents = true;
                parent.Exited += delegate { DesktopLease.BeforeStop(); Environment.Exit(0); };
                if (parent.HasExited) return 0;
                NativeDesktop.EnableDpiAwareness();
                var cancellationLock = new object();
                PendingInput latest = null;
                var reader = new Thread(delegate() {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        lock (cancellationLock)
                        {
                            // Private cancellation marker sent by native-connection. It never queues behind the drag.
                            if (line == "{\"operation\":\"cancel_current\",\"args\":{}}")
                            {
                                if (latest != null) latest.Cancellation.Cancel();
                                // This reader never enters UIA/COM. Revoke before acknowledging so a
                                // blocked action cannot press late or keep an accepted press held.
                                bool released = NativeDesktop.StopPointerInput();
                                Console.WriteLine("{\"cancel_ack\":true,\"pointerReleased\":" + (released ? "true" : "false") + "}");
                                continue;
                            }
                            latest = new PendingInput {Line=line};
                            input.Add(latest);
                        }
                    }
                    lock (cancellationLock) { if (latest != null) latest.Cancellation.Cancel(); }
                    // If Windows temporarily denies our up, retain this helper and
                    // its lease until the owned press can be released safely.
                    while (!NativeDesktop.StopPointerInput()) Thread.Sleep(100);
                    input.CompleteAdding();
                    // EOF ends this private connection, including a main thread blocked in COM.
                    Environment.Exit(0);
                }) { IsBackground = true };
                reader.Start();
                while (!input.IsCompleted)
                {
                    lease.ReleaseIfIdle();
                    PendingInput pending;
                    if (!input.TryTake(out pending, 250)) continue;
                    string reply;
                    try
                    {
                        IDictionary<string, object> arguments;
                        string operation = ParseRequest(pending.Line, out arguments);
                        var result = Dispatch(operation, arguments, lease,pending.Cancellation.Token);
                        lease.NoteActivity();
                        reply = Reply(result);
                    }
                    catch (Exception error) { reply = Error(error); }
                    finally
                    {
                        lock (cancellationLock) { if (latest == pending) latest=null; pending.Cancellation.Dispose(); }
                    }
                    Console.WriteLine(reply);
                }
            }
            return 0;
        }

        sealed class PendingInput
        {
            public string Line;
            public readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
        }
    }
}
