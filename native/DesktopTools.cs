// PC Link Windows desktop tools. The caller is responsible for permission checks.
// Build with System.Drawing, WindowsBase, UIAutomationClient and UIAutomationTypes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class DesktopTools {
    const int MaxImageBytes = 650000;
    const int MaxTextCharacters = 4096;
    static readonly object SnapshotGate = new object();
    static readonly Dictionary<string, UiaSnapshot> Snapshots = new Dictionary<string, UiaSnapshot>();
    static readonly Dictionary<string, ScreenSnapshot> Screenshots = new Dictionary<string, ScreenSnapshot>();
    static int UiaBusy;

    // Call once before constructing windows, and again on the worker thread.
    internal static void Initialize() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch {} }
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {}
    }

    internal static object Execute(string operation, Dictionary<string, object> args, string sharedRoot) {
        if (args == null) args = new Dictionary<string, object>();
        Initialize();
        if (operation == "screen") return Screenshot(args);
        if (operation == "windows") return Windows(args);
        if (operation == "ui_inspect") return Uia(delegate { return Inspect(args); });
        if (operation == "ui_action") return Uia(delegate { return Act(args); });
        if (operation == "desktop_input") return Input(args);
        throw new ArgumentException("Unknown desktop operation.");
    }

    static string Arg(Dictionary<string, object> a, string k, string fallback) {
        object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : fallback;
    }
    static int Number(Dictionary<string, object> a, string k, int fallback, int min, int max) {
        object value; if (!a.TryGetValue(k, out value) || value == null) return fallback;
        int parsed; if (!Int32.TryParse(Convert.ToString(value), out parsed) || parsed < min || parsed > max)
            throw new ArgumentException(k + " must be an integer from " + min + " to " + max + ".");
        return parsed;
    }
    static string HandleName(IntPtr h) { return "0x" + h.ToInt64().ToString("x"); }
    static IntPtr WindowHandle(Dictionary<string, object> a, bool allowActive) {
        string value = Arg(a, "window_id", "");
        IntPtr h;
        if (value.Length == 0 && allowActive) h = GetForegroundWindow();
        else {
            long parsed;
            if (!value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || !Int64.TryParse(value.Substring(2), System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out parsed) || parsed <= 0)
                throw new ArgumentException("Use a window_id returned by list_windows.");
            h = new IntPtr(parsed);
        }
        if (h == IntPtr.Zero || !IsWindow(h)) throw new InvalidOperationException("The window is no longer available.");
        return h;
    }
    static Rectangle VirtualBounds() {
        var r = new Rectangle(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
        if (r.Width <= 0 || r.Height <= 0) throw new InvalidOperationException("No interactive desktop is available.");
        return r;
    }
    static Rectangle WindowBounds(IntPtr h) {
        RECT r; if (!GetWindowRect(h, out r)) throw new InvalidOperationException("Cannot read the window bounds.");
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }
    static List<Rectangle> Monitors() {
        var result = new List<Rectangle>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref RECT r, IntPtr data) {
            result.Add(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom)); return true;
        }, IntPtr.Zero);
        return result;
    }
    static object Bounds(Rectangle r) { return new { x = r.X, y = r.Y, width = r.Width, height = r.Height }; }
    static object Screenshot(Dictionary<string, object> a) {
        string target = Arg(a, "target", "all").ToLowerInvariant();
        Rectangle area;
        if (target == "all") area = VirtualBounds();
        else if (target == "primary") area = new Rectangle(0, 0, GetSystemMetrics(0), GetSystemMetrics(1));
        else if (target == "monitor") {
            var monitors = Monitors(); int index = Number(a, "monitor_index", 0, 0, 15);
            if (index >= monitors.Count) throw new ArgumentException("That monitor is unavailable.");
            area = monitors[index];
        } else if (target == "active" || target == "activewindow" || target == "window") {
            IntPtr h = WindowHandle(a, target != "window");
            if (IsIconic(h)) throw new InvalidOperationException("The window is minimized. Restore it before taking a screenshot.");
            area = Rectangle.Intersect(WindowBounds(h), VirtualBounds());
        } else throw new ArgumentException("target must be all, primary, monitor, active, or window.");
        if (area.Width < 1 || area.Height < 1 || (long)area.Width * area.Height > 70000000)
            throw new InvalidOperationException("The selected desktop area is unavailable or too large.");
        int maxWidth = Number(a, "max_width", 1600, 320, 1600);
        int width = Math.Min(maxWidth, area.Width), height = Math.Max(1, (int)Math.Round((double)area.Height * width / area.Width));
        using (var source = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb)) {
            try { using (var graphics = Graphics.FromImage(source)) graphics.CopyFromScreen(area.Location, Point.Empty, area.Size, CopyPixelOperation.SourceCopy); }
            catch (Exception e) { throw new InvalidOperationException("Screenshot unavailable. Unlock the Windows desktop. " + e.Message); }
            using (var resized = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                using (var graphics = Graphics.FromImage(resized)) {
                    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    graphics.DrawImage(source, 0, 0, width, height);
                }
                byte[] bytes = Jpeg(resized, 65);
                if (bytes.Length > MaxImageBytes) bytes = Jpeg(resized, 45);
                if (bytes.Length > MaxImageBytes) bytes = Jpeg(resized, 25);
                if (bytes.Length > MaxImageBytes) throw new InvalidOperationException("Screenshot is too large. Use a smaller max_width or capture one monitor.");
                var monitors = new List<object>(); foreach (var m in Monitors()) monitors.Add(Bounds(m));
                string screenshotId = Guid.NewGuid().ToString("N");
                lock (SnapshotGate) {
                    PruneScreenshots(true);
                    Screenshots[screenshotId] = new ScreenSnapshot { Created = DateTime.UtcNow, Area = area, Desktop = VirtualBounds() };
                }
                return new {
                    ok = true,
                    screenshot_id = screenshotId,
                    expires_in_seconds = 120,
                    image = new { data = Convert.ToBase64String(bytes), mimeType = "image/jpeg", width = width, height = height, offsetX = area.X, offsetY = area.Y, scale = (double)width / area.Width, sourceWidth = area.Width, sourceHeight = area.Height },
                    monitors = monitors,
                    coordinates = "Input coordinates use physical screen pixels. Convert image positions with screenX = offsetX + imageX / scale and screenY = offsetY + imageY / scale."
                };
            }
        }
    }
    static byte[] Jpeg(Bitmap bitmap, long quality) {
        ImageCodecInfo encoder = null;
        foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.MimeType == "image/jpeg") { encoder = codec; break; }
        using (var stream = new MemoryStream()) using (var parameters = new EncoderParameters(1)) {
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            bitmap.Save(stream, encoder, parameters); return stream.ToArray();
        }
    }

    static object Windows(Dictionary<string, object> a) {
        string action = Arg(a, "action", "list").ToLowerInvariant();
        if (action != "list") {
            IntPtr h = WindowHandle(a, false);
            RejectOwnWindow(h);
            if (action == "activate") {
                if (IsIconic(h)) ShowWindow(h, 9);
                if (!SetForegroundWindow(h) || GetForegroundWindow() != h)
                    throw new InvalidOperationException("Windows prevented activation. Activate the app locally and try again.");
            } else if (action == "minimize") ShowWindow(h, 6);
            else if (action == "maximize") ShowWindow(h, 3);
            else if (action == "restore") ShowWindow(h, 9);
            else throw new ArgumentException("Window action must be list, activate, minimize, maximize, or restore.");
            return new { ok = true, window_id = HandleName(h), action = action, refresh_required = true };
        }
        var windows = new List<object>(); IntPtr foreground = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr data) {
            if (!IsWindowVisible(h) || windows.Count >= 250) return true;
            int length = GetWindowTextLength(h); if (length <= 0) return true;
            var title = new StringBuilder(Math.Min(length + 1, 1024)); GetWindowText(h, title, title.Capacity);
            var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string processName = ""; try { using (var process = Process.GetProcessById((int)pid)) processName = process.ProcessName; } catch {}
            RECT r; GetWindowRect(h, out r);
            windows.Add(new { window_id = HandleName(h), title = title.ToString(), process_id = pid, process = processName, class_name = cls.ToString(), active = h == foreground, minimized = IsIconic(h), bounds = Bounds(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom)) });
            return true;
        }, IntPtr.Zero);
        return new { ok = true, windows = windows, foreground_window_id = HandleName(foreground), desktop_bounds = Bounds(VirtualBounds()) };
    }

    sealed class UiaNode { internal AutomationElement Element; internal int[] Runtime; internal IntPtr RootWindow; }
    sealed class UiaSnapshot { internal DateTime Created; internal Dictionary<string, UiaNode> Nodes = new Dictionary<string, UiaNode>(); }
    sealed class ScreenSnapshot { internal DateTime Created; internal Rectangle Area, Desktop; }
    sealed class PendingNode { internal AutomationElement Element; internal int Depth; internal string Parent; }
    static object Uia(Func<object> operation) {
        // Providers may send messages to PC Link's UI. Never call them on its UI thread.
        if (Interlocked.CompareExchange(ref UiaBusy, 1, 0) != 0) throw new InvalidOperationException("UI inspection is busy. Try again after the current application responds.");
        object result = null; Exception error = null;
        var thread = new Thread(delegate() {
            try { Initialize(); result = operation(); } catch (Exception e) { error = e; }
            finally { Interlocked.Exchange(ref UiaBusy, 0); }
        });
        thread.IsBackground = true; thread.SetApartmentState(ApartmentState.MTA); thread.Start();
        if (!thread.Join(7000)) throw new TimeoutException("The application's UI Automation provider did not respond. It may be busy or inaccessible.");
        if (error != null) throw new InvalidOperationException(error.Message, error);
        return result;
    }
    static void PruneSnapshots(bool makeRoom = false) {
        var expired = new List<string>();
        foreach (var item in Snapshots) if ((DateTime.UtcNow - item.Value.Created).TotalSeconds > 120) expired.Add(item.Key);
        foreach (var id in expired) Snapshots.Remove(id);
        while (Snapshots.Count > (makeRoom ? 3 : 4)) {
            string oldest = null; DateTime time = DateTime.MaxValue;
            foreach (var item in Snapshots) if (item.Value.Created < time) { time = item.Value.Created; oldest = item.Key; }
            if (oldest == null) break; Snapshots.Remove(oldest);
        }
    }
    static void PruneScreenshots(bool makeRoom = false) {
        var expired = new List<string>();
        foreach (var item in Screenshots) if ((DateTime.UtcNow - item.Value.Created).TotalSeconds > 120) expired.Add(item.Key);
        foreach (var id in expired) Screenshots.Remove(id);
        while (Screenshots.Count > (makeRoom ? 3 : 4)) {
            string oldest = null; DateTime time = DateTime.MaxValue;
            foreach (var item in Screenshots) if (item.Value.Created < time) { time = item.Value.Created; oldest = item.Key; }
            if (oldest == null) break; Screenshots.Remove(oldest);
        }
    }
    static object Inspect(Dictionary<string, object> a) {
        IntPtr h = WindowHandle(a, true); int maximum = Number(a, "max_elements", 200, 1, 300), maximumDepth = Number(a, "depth", 6, 0, 10);
        var snapshot = new UiaSnapshot { Created = DateTime.UtcNow }; string snapshotId = Guid.NewGuid().ToString("N");
        var result = new List<object>(); var queue = new Queue<PendingNode>();
        queue.Enqueue(new PendingNode { Element = AutomationElement.FromHandle(h), Depth = 0, Parent = null });
        var timer = Stopwatch.StartNew(); bool truncated = false;
        while (queue.Count > 0 && result.Count < maximum && timer.ElapsedMilliseconds < 4500) {
            var item = queue.Dequeue();
            try {
                var current = item.Element.Current; string id = "e" + result.Count;
                bool password = current.IsPassword;
                var patterns = new List<string>();
                if (current.IsKeyboardFocusable) patterns.Add("focus");
                foreach (var pattern in item.Element.GetSupportedPatterns()) {
                    if (pattern == InvokePattern.Pattern) patterns.Add("invoke");
                    if (pattern == ValuePattern.Pattern && !password) patterns.Add("set_value");
                    if (pattern == SelectionItemPattern.Pattern) patterns.Add("select");
                    if (pattern == TogglePattern.Pattern) patterns.Add("toggle");
                    if (pattern == ExpandCollapsePattern.Pattern) { patterns.Add("expand"); patterns.Add("collapse"); }
                }
                var bounds = current.BoundingRectangle;
                snapshot.Nodes[id] = new UiaNode { Element = item.Element, Runtime = item.Element.GetRuntimeId(), RootWindow = h };
                string name = password ? "[password control]" : current.Name;
                if (name != null && name.Length > 400) name = name.Substring(0, 400);
                result.Add(new { element_id = id, parent_id = item.Parent, depth = item.Depth, name = name, control_type = current.ControlType.ProgrammaticName.Replace("ControlType.", ""), automation_id = current.AutomationId, class_name = current.ClassName, enabled = current.IsEnabled, offscreen = current.IsOffscreen, keyboard_focusable = current.IsKeyboardFocusable, password = password, bounds = new { x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height }, actions = patterns });
                // Never traverse password controls, and never request Value/Text patterns during inspection.
                if (!password && item.Depth < maximumDepth) {
                    var child = TreeWalker.ControlViewWalker.GetFirstChild(item.Element); int siblingLimit = 0;
                    while (child != null && siblingLimit++ < maximum && queue.Count + result.Count < maximum * 2 && timer.ElapsedMilliseconds < 4500) {
                        queue.Enqueue(new PendingNode { Element = child, Depth = item.Depth + 1, Parent = id });
                        child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                    }
                    if (child != null) truncated = true;
                }
            } catch (ElementNotAvailableException) { truncated = true; }
            catch (InvalidOperationException) { truncated = true; }
        }
        if (queue.Count > 0) truncated = true;
        lock (SnapshotGate) { PruneSnapshots(true); Snapshots[snapshotId] = snapshot; }
        return new { ok = true, window_id = HandleName(h), snapshot_id = snapshotId, expires_in_seconds = 120, elements = result, truncated = truncated, privacy = "Password controls are masked. Existing edit values and text patterns are never read." };
    }
    static object Act(Dictionary<string, object> a) {
        string snapshotId = Arg(a, "snapshot_id", ""), elementId = Arg(a, "element_id", ""), action = Arg(a, "action", "").ToLowerInvariant();
        UiaNode node; lock (SnapshotGate) {
            PruneSnapshots(); UiaSnapshot snapshot;
            if (!Snapshots.TryGetValue(snapshotId, out snapshot) || !snapshot.Nodes.TryGetValue(elementId, out node))
                throw new InvalidOperationException("This UI snapshot has expired. Inspect the window again.");
        }
        var runtime = node.Element.GetRuntimeId();
        if (runtime.Length != node.Runtime.Length) throw new InvalidOperationException("The UI element changed. Inspect the window again.");
        for (int i = 0; i < runtime.Length; i++) if (runtime[i] != node.Runtime[i]) throw new InvalidOperationException("The UI element changed. Inspect the window again.");
        var current = node.Element.Current;
        RejectOwnWindow(node.RootWindow);
        if (current.ProcessId == Process.GetCurrentProcess().Id) throw new InvalidOperationException("PC Link cannot control its own permission or configuration UI.");
        if (!current.IsEnabled) throw new InvalidOperationException("The UI element is disabled.");
        if (current.IsPassword && action == "set_value") throw new InvalidOperationException("Setting password controls through UI Automation is disabled.");
        object pattern;
        if (action == "focus") node.Element.SetFocus();
        else if (action == "invoke" && node.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) ((InvokePattern)pattern).Invoke();
        else if (action == "set_value" && node.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
            string value = Arg(a, "value", ""); if (value.Length > MaxTextCharacters || value.IndexOf('\0') >= 0) throw new ArgumentException("Value is too long or contains NUL.");
            if (((ValuePattern)pattern).Current.IsReadOnly) throw new InvalidOperationException("The UI value is read only.");
            ((ValuePattern)pattern).SetValue(value);
        } else if (action == "select" && node.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) ((SelectionItemPattern)pattern).Select();
        else if (action == "toggle" && node.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) ((TogglePattern)pattern).Toggle();
        else if (action == "expand" && node.Element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) ((ExpandCollapsePattern)pattern).Expand();
        else if (action == "collapse" && node.Element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) ((ExpandCollapsePattern)pattern).Collapse();
        else throw new ArgumentException("This element does not support that action. Inspect its actions first.");
        lock (SnapshotGate) Snapshots.Remove(snapshotId);
        return new { ok = true, action = action, element_id = elementId, refresh_required = true };
    }

    static object Input(Dictionary<string, object> a) {
        string action = Arg(a, "action", "").ToLowerInvariant();
        var inputs = new List<INPUT>(); Rectangle desktop = VirtualBounds();
        IntPtr keyboardTarget = IntPtr.Zero;
        if (action == "move" || action == "click") {
            Point point = FreshCoordinate(a, desktop); inputs.Add(MouseMove(point, desktop));
            if (action == "click") {
                string button = Arg(a, "button", "left").ToLowerInvariant(); uint down, up;
                if (button == "left") { down = 2; up = 4; } else if (button == "right") { down = 8; up = 16; } else if (button == "middle") { down = 32; up = 64; } else throw new ArgumentException("button must be left, right, or middle.");
                int count = Number(a, "count", 1, 1, 2);
                for (int i = 0; i < count; i++) { inputs.Add(Mouse(down, 0)); inputs.Add(Mouse(up, 0)); }
            }
        } else if (action == "scroll") {
            bool x = a.ContainsKey("x"), y = a.ContainsKey("y"); if (x != y) throw new ArgumentException("Specify both x and y for scrolling at a position.");
            if (x) inputs.Add(MouseMove(FreshCoordinate(a, desktop), desktop));
            else keyboardTarget = ForegroundTarget(a);
            int steps = Number(a, "steps", 0, -30, 30); if (steps == 0) throw new ArgumentException("Scroll steps cannot be zero.");
            string direction = Arg(a, "axis", "vertical").ToLowerInvariant(); if (direction != "vertical" && direction != "horizontal") throw new ArgumentException("axis must be vertical or horizontal.");
            inputs.Add(Mouse(direction == "vertical" ? 0x800U : 0x1000U, unchecked((uint)(steps * 120))));
        } else if (action == "type") { keyboardTarget = ForegroundTarget(a); inputs.AddRange(UnicodeInput(Arg(a, "text", ""))); }
        else if (action == "key") { keyboardTarget = ForegroundTarget(a); inputs.AddRange(KeyInput(Arg(a, "key", ""))); }
        else throw new ArgumentException("Input action must be move, click, scroll, type, or key.");
        if (inputs.Count == 0) return new { ok = true, action = action, events = 0 };
        // Do not interrupt a physical modifier the person is currently holding.
        foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5b, 0x5c })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InvalidOperationException("A modifier key is held locally. Release it before remote input.");
        if (keyboardTarget != IntPtr.Zero && keyboardTarget != GetForegroundWindow()) throw new InvalidOperationException("The foreground application changed. Inspect the current window before sending input.");
        uint inserted = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        if (inserted != inputs.Count) {
            // Release only keys/buttons this operation attempted to press.
            var releases = new List<INPUT>();
            foreach (var input in inputs) {
                if (input.type == 1 && (input.u.ki.dwFlags & 2) == 0) { var release = input; release.u.ki.dwFlags |= 2; releases.Add(release); }
                if (input.type == 0 && (input.u.mi.dwFlags == 2 || input.u.mi.dwFlags == 8 || input.u.mi.dwFlags == 32)) releases.Add(Mouse(input.u.mi.dwFlags << 1, 0));
            }
            if (releases.Count > 0) SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            throw new InvalidOperationException("Windows accepted " + inserted + " of " + inputs.Count + " input events. The app may be elevated or the desktop locked. Check the screen before retrying.");
        }
        POINT position; GetCursorPos(out position);
        return new { ok = true, action = action, events = inserted, cursor = new { x = position.X, y = position.Y }, foreground_window_id = HandleName(GetForegroundWindow()), refresh_required = true };
    }
    static IntPtr ForegroundTarget(Dictionary<string, object> a) {
        IntPtr h = WindowHandle(a, false);
        RejectOwnWindow(h);
        if (h != GetForegroundWindow()) throw new InvalidOperationException("window_id must match the current foreground application. Activate and inspect that window first.");
        return h;
    }
    static Point FreshCoordinate(Dictionary<string, object> a, Rectangle desktop) {
        Point point = Coordinate(a, desktop);
        string id = Arg(a, "expected_screenshot_id", ""); ScreenSnapshot screenshot;
        lock (SnapshotGate) {
            PruneScreenshots();
            if (!Screenshots.TryGetValue(id, out screenshot)) throw new InvalidOperationException("A recent expected_screenshot_id is required. Take a screenshot before coordinate input.");
            if (screenshot.Desktop != desktop) throw new InvalidOperationException("The monitor layout changed. Take a new screenshot.");
            if (!screenshot.Area.Contains(point)) throw new InvalidOperationException("Those coordinates are outside the referenced screenshot.");
        }
        bool visible = false; foreach (var monitor in Monitors()) if (monitor.Contains(point)) { visible = true; break; }
        if (!visible) throw new ArgumentException("Those coordinates do not belong to a connected monitor.");
        IntPtr hit = WindowFromPoint(new POINT { X = point.X, Y = point.Y });
        RejectOwnWindow(hit);
        if (hit != IntPtr.Zero) RejectOwnWindow(GetAncestor(hit, 2));
        return point;
    }
    static void RejectOwnWindow(IntPtr h) {
        if (h == IntPtr.Zero) return;
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid == (uint)Process.GetCurrentProcess().Id) throw new InvalidOperationException("PC Link cannot control its own permission or configuration UI.");
    }
    internal static Point Coordinate(Dictionary<string, object> a, Rectangle desktop) {
        if (!a.ContainsKey("x") || !a.ContainsKey("y")) throw new ArgumentException("Both physical screen coordinates x and y are required.");
        int x = Number(a, "x", 0, desktop.Left, desktop.Right - 1), y = Number(a, "y", 0, desktop.Top, desktop.Bottom - 1);
        return new Point(x, y);
    }
    static INPUT MouseMove(Point point, Rectangle desktop) {
        return new INPUT { type = 0, u = new InputUnion { mi = new MOUSEINPUT { dx = (int)Math.Round((double)(point.X - desktop.Left) * 65535 / Math.Max(1, desktop.Width - 1)), dy = (int)Math.Round((double)(point.Y - desktop.Top) * 65535 / Math.Max(1, desktop.Height - 1)), dwFlags = 0x0001 | 0x8000 | 0x4000 } } };
    }
    static INPUT Mouse(uint flags, uint data) { return new INPUT { type = 0, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags, mouseData = data } } }; }
    static INPUT Keyboard(ushort key, ushort scan, uint flags) { return new INPUT { type = 1, u = new InputUnion { ki = new KEYBDINPUT { wVk = key, wScan = scan, dwFlags = flags } } }; }
    internal static INPUT[] UnicodeInput(string text) {
        if (text.Length > MaxTextCharacters || text.IndexOf('\0') >= 0) throw new ArgumentException("Text must contain at most 4096 characters and no NUL.");
        var inputs = new List<INPUT>();
        for (int i = 0; i < text.Length; i++) {
            char c = text[i];
            if (c == '\r' || c == '\n' || c == '\t') {
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                ushort key = c == '\t' ? (ushort)0x09 : (ushort)0x0d;
                inputs.Add(Keyboard(key, 0, 0)); inputs.Add(Keyboard(key, 0, 2));
            } else {
                if (Char.IsControl(c)) throw new ArgumentException("Text contains an unsupported control character.");
                inputs.Add(Keyboard(0, c, 4)); inputs.Add(Keyboard(0, c, 4 | 2));
            }
        }
        return inputs.ToArray();
    }
    internal static INPUT[] KeyInput(string chord) {
        if (String.IsNullOrWhiteSpace(chord) || chord.Length > 80) throw new ArgumentException("Enter a key such as ENTER or CTRL+SHIFT+S.");
        string[] names = chord.ToUpperInvariant().Split('+'); var keys = new List<ushort>(); var modifiers = new HashSet<ushort>(); ushort main = 0;
        foreach (string item in names) {
            string key = item.Trim(); ushort modifier = key == "CTRL" || key == "CONTROL" ? (ushort)0x11 : key == "ALT" ? (ushort)0x12 : key == "SHIFT" ? (ushort)0x10 : key == "WIN" || key == "WINDOWS" || key == "META" ? (ushort)0x5b : (ushort)0;
            if (modifier != 0) { if (main != 0 || !modifiers.Add(modifier)) throw new ArgumentException("Modifiers must be unique and precede the final key."); keys.Add(modifier); }
            else { if (main != 0) throw new ArgumentException("Use one final key per key chord."); main = VirtualKey(key); }
        }
        if (main == 0) throw new ArgumentException("A key chord needs a final key.");
        if (main == 0x2e && modifiers.Contains(0x11) && modifiers.Contains(0x12)) throw new ArgumentException("CTRL+ALT+DELETE requires the Windows secure desktop and cannot be sent remotely.");
        keys.Add(main); var inputs = new List<INPUT>();
        foreach (ushort key in keys) inputs.Add(Keyboard(key, 0, ExtendedKey(key) ? 1U : 0U));
        for (int i = keys.Count - 1; i >= 0; i--) inputs.Add(Keyboard(keys[i], 0, (ExtendedKey(keys[i]) ? 1U : 0U) | 2));
        return inputs.ToArray();
    }
    static bool ExtendedKey(ushort key) { return key >= 0x21 && key <= 0x2e || key == 0x5b || key == 0x5c; }
    static ushort VirtualKey(string key) {
        if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9'))) return key[0];
        int function; if (key.Length > 1 && key[0] == 'F' && Int32.TryParse(key.Substring(1), out function) && function >= 1 && function <= 24) return (ushort)(0x70 + function - 1);
        switch (key) {
            case "ENTER": case "RETURN": return 0x0d;
            case "TAB": return 0x09;
            case "ESC": case "ESCAPE": return 0x1b;
            case "SPACE": return 0x20;
            case "BACKSPACE": return 0x08;
            case "DELETE": case "DEL": return 0x2e;
            case "INSERT": case "INS": return 0x2d;
            case "HOME": return 0x24;
            case "END": return 0x23;
            case "PAGEUP": case "PGUP": return 0x21;
            case "PAGEDOWN": case "PGDN": return 0x22;
            case "LEFT": return 0x25;
            case "UP": return 0x26;
            case "RIGHT": return 0x27;
            case "DOWN": return 0x28;
            case "PRINTSCREEN": return 0x2c;
            case "PAUSE": return 0x13;
            case "CAPSLOCK": return 0x14;
            case "NUMLOCK": return 0x90;
            case "SCROLLLOCK": return 0x91;
            case "PLUS": return 0xbb;
            case "MINUS": return 0xbd;
            case "COMMA": return 0xbc;
            case "PERIOD": return 0xbe;
        }
        throw new ArgumentException("Unsupported key. Use letters, digits, F1-F24, or a named navigation key.");
    }

    [StructLayout(LayoutKind.Sequential)] internal struct INPUT { internal uint type; internal InputUnion u; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputUnion { [FieldOffset(0)] internal MOUSEINPUT mi; [FieldOffset(0)] internal KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] internal struct MOUSEINPUT { internal int dx, dy; internal uint mouseData, dwFlags, time; internal UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct KEYBDINPUT { internal ushort wVk, wScan; internal uint dwFlags, time; internal UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { internal int X, Y; }
    delegate bool EnumWindowsProc(IntPtr h, IntPtr data);
    delegate bool MonitorProc(IntPtr h, IntPtr dc, ref RECT r, IntPtr data);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
}

#if DESKTOP_TEST
static class DesktopToolsTest {
    static void Check(bool okay, string label) { if (!okay) throw new Exception(label); }
    static void Reject(Action action, string label) { bool denied = false; try { action(); } catch (ArgumentException) { denied = true; } Check(denied, label); }
    static void RejectUnsafe(Action action, string label) { bool denied = false; try { action(); } catch (InvalidOperationException) { denied = true; } catch (ArgumentException) { denied = true; } Check(denied, label); }
    static readonly System.Web.Script.Serialization.JavaScriptSerializer Json = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = 2000000 };
    static Dictionary<string, object> Object(object value) { return Json.Deserialize<Dictionary<string, object>>(Json.Serialize(value)); }
    [STAThread] static void Main(string[] args) {
        try {
            Check(Marshal.SizeOf(typeof(DesktopTools.INPUT)) == (IntPtr.Size == 8 ? 40 : 28), "SendInput structure alignment");
            var chord = DesktopTools.KeyInput("ctrl+shift+s"); Check(chord.Length == 6 && chord[0].u.ki.wVk == 0x11 && chord[3].u.ki.wVk == 'S' && (chord[3].u.ki.dwFlags & 2) != 0, "key chord ordering");
            Check(DesktopTools.KeyInput("F24")[0].u.ki.wVk == 0x87, "function keys");
            Reject(delegate { DesktopTools.KeyInput("CTRL+CTRL+A"); }, "duplicate modifiers");
            Reject(delegate { DesktopTools.KeyInput("A+B"); }, "multiple main keys");
            Reject(delegate { DesktopTools.KeyInput("CTRL+ALT+DELETE"); }, "secure desktop chord");
            Reject(delegate { DesktopTools.KeyInput("CTRL"); }, "modifier-only chord");
            Reject(delegate { DesktopTools.KeyInput("F25"); }, "function key bounds");
            Check(DesktopTools.UnicodeInput("λ😀").Length == 6, "unicode and surrogate pairs");
            Check(DesktopTools.UnicodeInput("a\r\nb\t").Length == 8, "newline and tab input");
            Reject(delegate { DesktopTools.UnicodeInput(new string('a', 4097)); }, "text size limit");
            Reject(delegate { DesktopTools.UnicodeInput("a\0b"); }, "NUL input");
            var display = new Rectangle(-1920, 0, 3840, 1080);
            var point = DesktopTools.Coordinate(new Dictionary<string, object> { { "x", -1920 }, { "y", 1079 } }, display); Check(point.X == -1920, "negative monitor coordinates");
            Reject(delegate { DesktopTools.Coordinate(new Dictionary<string, object> { { "x", 1920 }, { "y", 0 } }, display); }, "screen bounds");
            Reject(delegate { DesktopTools.Coordinate(new Dictionary<string, object> { { "x", 0.5 }, { "y", 0 } }, display); }, "fractional coordinate");
            Console.WriteLine("PASS: input marshaling, key parsing/order, Unicode, text limits, screen coordinate boundaries. No input events sent.");
            if (Array.IndexOf(args, "--live-readonly") >= 0) {
                var windows = Object(DesktopTools.Execute("windows", new Dictionary<string, object>(), ".")); Check(Convert.ToBoolean(windows["ok"]), "window enumeration");
                var capture = Object(DesktopTools.Execute("screen", new Dictionary<string, object> { { "target", "primary" }, { "max_width", 800 } }, "."));
                var image = (Dictionary<string, object>)capture["image"]; byte[] jpeg = Convert.FromBase64String(Convert.ToString(image["data"]));
                Check(jpeg.Length > 10 && jpeg[0] == 0xff && jpeg[1] == 0xd8 && Convert.ToString(capture["screenshot_id"]).Length == 32, "JPEG payload and screenshot ID");
                using (var stream = new MemoryStream(jpeg)) using (var decoded = Image.FromStream(stream)) Check(decoded.Width == Convert.ToInt32(image["width"]), "JPEG dimensions");
                var inspection = Object(DesktopTools.Execute("ui_inspect", new Dictionary<string, object> { { "max_elements", 40 }, { "depth", 3 } }, "."));
                Check(Convert.ToBoolean(inspection["ok"]) && Convert.ToString(inspection["snapshot_id"]).Length == 32, "UI snapshot");
                RejectUnsafe(delegate { DesktopTools.Execute("desktop_input", new Dictionary<string, object> { { "action", "click" }, { "x", 0 }, { "y", 0 } }, "."); }, "coordinate input without screenshot ID");
                RejectUnsafe(delegate { DesktopTools.Execute("desktop_input", new Dictionary<string, object> { { "action", "key" }, { "key", "ENTER" } }, "."); }, "key input without foreground window ID");
                RejectUnsafe(delegate { DesktopTools.Execute("desktop_input", new Dictionary<string, object> { { "action", "type" }, { "text", "do not type this" }, { "window_id", "0x1" } }, "."); }, "typing with stale window ID");
                Console.WriteLine("PASS: live read-only window enumeration, primary-screen JPEG, and active-window UI Automation inspection. No titles, UI content, or screenshots saved.");
                Console.WriteLine("PASS: coordinate input without a fresh screenshot and typing without a current foreground window were rejected before sending input.");
            }
        } catch (Exception e) { Console.Error.WriteLine("FAIL: " + e.Message); Environment.ExitCode = 1; }
    }
}
#endif
