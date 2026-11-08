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

        internal static string Field(IDictionary<string, object> data, string key, bool required = true)
        {
            object value;
            if (data.TryGetValue(key, out value) && value is string) return (string)value;
            if (!required) return null;
            throw new ArgumentException("Expected a string for " + key);
        }

        internal static object Dispatch(string op, IDictionary<string, object> a, DesktopLease lease)
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
            if (op == "release_control") { Visual.Clear(); Automation.Clear(); lease.Release(); return new { released = true }; }
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
            using (var input = new BlockingCollection<string>())
            {
                parent.EnableRaisingEvents = true;
                parent.Exited += delegate { Environment.Exit(0); };
                if (parent.HasExited) return 0;
                NativeDesktop.EnableDpiAwareness();
                var reader = new Thread(delegate() {
                    string line;
                    while ((line = Console.ReadLine()) != null) input.Add(line);
                    input.CompleteAdding();
                }) { IsBackground = true };
                reader.Start();
                while (!input.IsCompleted)
                {
                    lease.ReleaseIfIdle();
                    string line;
                    if (!input.TryTake(out line, 250)) continue;
                    string reply;
                    try
                    {
                        IDictionary<string, object> arguments;
                        string operation = ParseRequest(line, out arguments);
                        var result = Dispatch(operation, arguments, lease);
                        lease.NoteActivity();
                        reply = Reply(result);
                    }
                    catch (Exception error) { reply = Error(error); }
                    Console.WriteLine(reply);
                }
            }
            return 0;
        }
    }
}
