using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;

namespace AgentOS.Computer
{
    internal sealed class AutomationDesktop
    {
        private const int PageSize = 64;
        private const int PageMilliseconds = 800;
        private const int TargetTreePageSize = 256;
        private const int MaxRetainedControls = 3 * TargetTreePageSize;
        private const int TargetTreeMilliseconds = 2000;
        private const int MaxContextLabels = 8;
        private const int MaxAncestorSteps = 256;

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowRect
        {
            public int Left, Top, Right, Bottom;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hwnd, out WindowRect rect);

        private enum Direction { Root, FirstChild, NextSibling }

        private class ControlLabel
        {
            public string name, controlType;
        }

        private class ControlRow : ControlLabel
        {
            public string id, parentId, automationId, value;
            public object bounds;
            public bool enabled, isPassword;
            public List<string> patterns;
        }

        private sealed class TargetControlRow : ControlRow
        {
            public ControlLabel[] ancestors;
            public bool isOffscreen;
        }

        private sealed class Navigation
        {
            public AutomationElement Anchor;
            public string ParentId;
            public Direction Direction;
            public int Depth;
            public ControlLabel[] Ancestors;
        }

        private readonly CacheRequest cache = BuildCache();
        private readonly TreeWalker walker = TreeWalker.ControlViewWalker;
        private readonly Stack<Navigation> pending = new Stack<Navigation>();
        private readonly Dictionary<string, AutomationElement> controls = new Dictionary<string, AutomationElement>();
        private string windowId, observationId, nextCursor;
        private bool targetTreeCursor;
        private AutomationElement root;
        private IntPtr window;
        private WindowRect bounds;
        private long nextControl;

        public void Clear()
        {
            windowId = observationId = nextCursor = null;
            root = null;
            window = IntPtr.Zero;
            pending.Clear();
            controls.Clear();
        }

        private static CacheRequest BuildCache()
        {
            // Fetch one control's metadata in a single provider request. In particular,
            // never request the Value property as part of this unconditional cache.
            var request = new CacheRequest { TreeScope = TreeScope.Element };
            foreach (var property in new AutomationProperty[] {
                AutomationElement.NameProperty, AutomationElement.AutomationIdProperty,
                AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty,
                AutomationElement.IsEnabledProperty, AutomationElement.IsPasswordProperty, AutomationElement.IsOffscreenProperty,
                AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
                AutomationElement.IsSelectionItemPatternAvailableProperty, ValuePattern.IsReadOnlyProperty
            }) request.Add(property);
            return request;
        }

        private static WindowRect Measure(IntPtr hwnd)
        {
            WindowRect rect;
            if (!GetWindowRect(hwnd, out rect))
                throw new InvalidOperationException("The window is no longer available. Observe the desktop again.");
            return rect;
        }

        private static object ScreenBounds(Rect rect)
        {
            if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0 ||
                !IsFinite(rect.X) || !IsFinite(rect.Y) || !IsFinite(rect.Width) || !IsFinite(rect.Height))
                return null;
            return new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height };
        }

        private static bool SameBounds(WindowRect a, WindowRect b)
        {
            return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
        }

        private static bool IsFinite(double coordinate)
        {
            return !Double.IsInfinity(coordinate) && !Double.IsNaN(coordinate);
        }

        private static bool Available(AutomationElement element, AutomationProperty property)
        {
            return Object.Equals(element.GetCachedPropertyValue(property, true), true);
        }

        private static string Clip(string text, int limit)
        {
            if (text == null || text.Length <= limit) return text;
            if (Char.IsHighSurrogate(text[limit - 1])) limit--;
            return text.Substring(0, limit) + "…";
        }

        private static string ReadValue(AutomationElement element)
        {
            // Require an explicit negative password flag before asking for any value.
            // Providers can omit either property or withdraw a control during traversal.
            if (!Object.Equals(element.GetCachedPropertyValue(AutomationElement.IsPasswordProperty, true), false) ||
                !Available(element, AutomationElement.IsValuePatternAvailableProperty)) return null;
            try
            {
                var value = element.GetCurrentPropertyValue(ValuePattern.ValueProperty, true) as string;
                if (!Object.Equals(element.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true), false)) return null;
                return Clip(value, 512);
            }
            catch (ElementNotAvailableException) { return null; }
            catch (InvalidOperationException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
            catch (COMException) { return null; }
        }

        private static ControlRow Describe(AutomationElement element, string id, Navigation nav)
        {
            var info = element.Cached;
            var patterns = new List<string>();
            if (Available(element, AutomationElement.IsInvokePatternAvailableProperty)) patterns.Add("invoke");
            if (Available(element, AutomationElement.IsValuePatternAvailableProperty) &&
                !Available(element, ValuePattern.IsReadOnlyProperty)) patterns.Add("setValue");
            if (Available(element, AutomationElement.IsSelectionItemPatternAvailableProperty)) patterns.Add("select");
            var type = info.ControlType;
            var row = nav.Ancestors == null ? new ControlRow() : new TargetControlRow {
                ancestors = nav.Ancestors, isOffscreen = info.IsOffscreen
            };
            row.id = id;
            row.parentId = nav.ParentId;
            row.name = info.IsPassword ? null : Clip(info.Name, 256);
            row.controlType = type == null ? null : type.ProgrammaticName.Replace("ControlType.", "");
            row.automationId = Clip(info.AutomationId, 256);
            row.bounds = ScreenBounds(info.BoundingRectangle);
            row.enabled = info.IsEnabled;
            row.patterns = patterns;
            row.isPassword = info.IsPassword;
            row.value = ReadValue(element);
            return row;
        }

        // Siblings share their path. Copy only clipped labels when descending.
        private static ControlLabel[] ChildAncestors(ControlLabel[] ancestors, ControlRow parent)
        {
            if (ancestors == null) return null;
            int keep = Math.Min(ancestors.Length, MaxContextLabels - 1);
            var path = new ControlLabel[keep + 1];
            Array.Copy(ancestors, ancestors.Length - keep, path, 0, keep);
            path[keep] = new ControlLabel { name = parent.name, controlType = parent.controlType };
            return path;
        }

        public object Observe(string windowId)
        {
            return Observe(windowId, null);
        }

        public object Observe(string windowId, string cursor)
        {
            return Observe(windowId, cursor, false);
        }

        public object ObserveTargetTree(string windowId, string cursor, string extendObservationId = null)
        {
            return Observe(windowId, cursor, true, extendObservationId);
        }

        private object Observe(string windowId, string cursor, bool targetTree, string extendObservationId = null)
        {
            if (cursor != null && (cursor != nextCursor || this.windowId != windowId || targetTree != targetTreeCursor))
                throw new InvalidOperationException("This page cursor has expired. Observe the window again.");
            if (extendObservationId != null)
            {
                if (cursor == null || extendObservationId != observationId)
                    throw new InvalidOperationException("A valid cursor and its current observation are required to extend the tree.");
                if (controls.Count >= MaxRetainedControls)
                    throw new InvalidOperationException("The retained control limit was reached. Continue without extending the observation.");
            }

            // The helper serves requests serially. Invalidate actions even if the
            // provider disappears during the replacement observation.
            observationId = null;
            nextCursor = null;
            if (extendObservationId == null) controls.Clear();
            try
            {
                var timer = Stopwatch.StartNew();
                var hwnd = NativeDesktop.Resolve(windowId);
                var startBounds = Measure(hwnd);
                AutomationElement liveRoot;
                using (cache.Activate()) liveRoot = AutomationElement.FromHandle(hwnd);
                if (cursor == null)
                {
                    pending.Clear();
                    root = liveRoot;
                    window = hwnd;
                    this.windowId = windowId;
                    targetTreeCursor = targetTree;
                    nextControl = 0;
                    pending.Push(new Navigation { Anchor = root, Direction = Direction.Root,
                        Ancestors = targetTree ? new ControlLabel[0] : null });
                }
                else if (hwnd != window || !Automation.Compare(root, liveRoot))
                    throw new InvalidOperationException("The window changed while paging. Observe it again.");
                else if (targetTree && !SameBounds(bounds, startBounds))
                    throw new InvalidOperationException("The window moved or resized while paging. Observe it again.");

                var rows = new List<object>();
                int unavailableBranches = 0;
                int pageSize = targetTree ? TargetTreePageSize : PageSize;
                int rowLimit = Math.Min(pageSize, MaxRetainedControls - controls.Count);
                int milliseconds = targetTree ? TargetTreeMilliseconds : PageMilliseconds;
                if (!targetTree) timer.Restart();
                for (int step = 0; pending.Count > 0 && step < pageSize * 4 && rows.Count < rowLimit; step++)
                {
                    if (step > 0 && timer.ElapsedMilliseconds >= milliseconds) break;
                    var nav = pending.Pop();
                    try
                    {
                        var element = nav.Anchor;
                        if (nav.Direction == Direction.FirstChild) element = walker.GetFirstChild(element, cache);
                        if (nav.Direction == Direction.NextSibling) element = walker.GetNextSibling(element, cache);
                        if (element == null) continue;
                        // Act verifies the same maximum depth when following a
                        // control to its root. Keep the resumable frontier bounded.
                        if (targetTree && nav.Depth >= MaxAncestorSteps) { unavailableBranches++; continue; }

                        var id = (++nextControl).ToString(CultureInfo.InvariantCulture);
                        if (nav.ParentId != null)
                            pending.Push(new Navigation { Anchor = element, ParentId = nav.ParentId, Direction = Direction.NextSibling,
                                Depth = nav.Depth, Ancestors = nav.Ancestors });
                        var row = Describe(element, id, nav);
                        controls.Add(id, element);
                        rows.Add(row);
                        if (!row.isPassword)
                            pending.Push(new Navigation { Anchor = element, ParentId = id, Direction = Direction.FirstChild,
                                Depth = nav.Depth + 1, Ancestors = ChildAncestors(nav.Ancestors, row) });
                    }
                    catch (ElementNotAvailableException) { if (nav.Direction == Direction.Root) throw; unavailableBranches++; }
                    catch (UnauthorizedAccessException) { if (nav.Direction == Direction.Root) throw; unavailableBranches++; }
                    catch (COMException) { if (nav.Direction == Direction.Root) throw; unavailableBranches++; }
                }
                if (targetTree && !SameBounds(startBounds, Measure(hwnd)))
                    throw new InvalidOperationException("The window moved or resized during observation. Observe it again.");
                bounds = startBounds;
                observationId = Guid.NewGuid().ToString("N");
                if (pending.Count > 0) nextCursor = Guid.NewGuid().ToString("N");
                return new {
                    observationId = observationId, windowId = windowId, controls = rows,
                    bounds = new { x = bounds.Left, y = bounds.Top, width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top },
                    truncated = nextCursor != null, nextCursor = nextCursor, unavailableBranches = unavailableBranches
                };
            }
            catch (ElementNotAvailableException)
            {
                throw new InvalidOperationException("The window disappeared during observation. Observe the desktop again.");
            }
        }

        private void CheckWindow(string requestedWindow, string requestedObservation)
        {
            if (observationId == null || requestedObservation != observationId || requestedWindow != windowId)
                throw new InvalidOperationException("This observation has expired or belongs to another window. Observe the target again.");
            if (NativeDesktop.Resolve(requestedWindow) != window || !Automation.Compare(root, AutomationElement.FromHandle(window)))
                throw new InvalidOperationException("The observed window was replaced. Observe the desktop again.");
        }

        public void ValidateObservation(string windowId, string observationId)
        {
            CheckWindow(windowId, observationId);
            var now = Measure(window);
            if (!SameBounds(now, bounds))
                throw new InvalidOperationException("The window moved or resized. Observe it again before using coordinates.");
        }

        private bool BelongsToWindow(AutomationElement element)
        {
            var timer = Stopwatch.StartNew();
            for (int depth = 0; element != null && depth < MaxAncestorSteps && timer.ElapsedMilliseconds < 2000; depth++)
            {
                if (Automation.Compare(element, root)) return true;
                element = walker.GetParent(element);
            }
            return false;
        }

        private static T RequirePattern<T>(AutomationElement element, AutomationPattern pattern) where T : class
        {
            object result;
            if (!element.TryGetCurrentPattern(pattern, out result))
                throw new InvalidOperationException("This control does not support the requested action.");
            return (T)result;
        }

        public object Act(string windowId, string observationId, string controlId, string action, string value,
            Action<int, int, bool> movePointer)
        {
            try
            {
                CheckWindow(windowId, observationId);
                AutomationElement element;
                if (controlId == null || !controls.TryGetValue(controlId, out element))
                    throw new InvalidOperationException("Unknown control in this observation. Observe its page again.");
                var current = element.GetUpdatedCache(cache);
                var was = element.Cached;
                var now = current.Cached;
                if (was.ControlType != now.ControlType || was.AutomationId != now.AutomationId ||
                    was.IsPassword != now.IsPassword || (!now.IsPassword && was.Name != now.Name) || !BelongsToWindow(current))
                    throw new InvalidOperationException("The control changed or left the target window. Observe the window again.");
                if (!now.IsEnabled) throw new InvalidOperationException("The control is disabled.");

                // Use the provider's current physical bounds while the target still exists.
                // Invoke can open a dialog or remove this element from the tree.
                var target = now.BoundingRectangle;
                target.Intersect(new Rect(new Point(bounds.Left, bounds.Top), new Point(bounds.Right, bounds.Bottom)));
                bool showTarget = !now.IsOffscreen && !target.IsEmpty && target.Width > 0 && target.Height > 0 &&
                    IsFinite(target.X) && IsFinite(target.Y) && IsFinite(target.Width) && IsFinite(target.Height);
                Action<bool> indicate = delegate(bool pressed) {
                    if (showTarget) movePointer((int)Math.Floor(target.X + target.Width / 2),
                        (int)Math.Floor(target.Y + target.Height / 2), pressed);
                };
                switch (action)
                {
                    case "invoke":
                        var invoker = RequirePattern<InvokePattern>(current, InvokePattern.Pattern);
                        indicate(true);
                        invoker.Invoke();
                        break;
                    case "setValue":
                        if (value == null) throw new InvalidOperationException("setValue requires a string value.");
                        var setter = RequirePattern<ValuePattern>(current, ValuePattern.Pattern);
                        if (setter.Current.IsReadOnly) throw new InvalidOperationException("The control is read-only.");
                        indicate(false);
                        setter.SetValue(value);
                        break;
                    case "select":
                        var selector = RequirePattern<SelectionItemPattern>(current, SelectionItemPattern.Pattern);
                        indicate(true);
                        selector.Select();
                        break;
                    default: throw new InvalidOperationException("Unknown UI Automation action. Use invoke, setValue or select.");
                }
                return new { ok = true, windowId = windowId, observationId = observationId, controlId = controlId,
                             action = action, bounds = ScreenBounds(now.BoundingRectangle) };
            }
            catch (ElementNotAvailableException)
            {
                throw new InvalidOperationException("The control is no longer available. Observe the window again.");
            }
            catch (ElementNotEnabledException)
            {
                throw new InvalidOperationException("The control is disabled.");
            }
            catch (COMException)
            {
                throw new InvalidOperationException("The application's accessibility provider failed. Observe the result before retrying.");
            }
        }

    }
}
