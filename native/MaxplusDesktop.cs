// Standalone JSON-lines desktop backend. Uses documented Windows APIs only.
// Compile with the Windows .NET Framework compiler; see build-desktop.ps1.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class MaxplusDesktop
{
    const string Version = "1.1.0";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 80 };
    static readonly string[] Programs = { "max2win.exe", "maxplus2.exe", "megawiz.exe", "genmem.exe", "wlarithm.exe", "wlsum.exe", "wlcount.exe", "wlmux.exe", "wlram.exe", "wlclshif.exe", "wdivide.exe" };
    static readonly Dictionary<int, AutomationElement> Elements = new Dictionary<int, AutomationElement>();
    static readonly Dictionary<int, Rectangle> ElementBounds = new Dictionary<int, Rectangle>();
    static readonly Dictionary<int, IntPtr> ElementWindows = new Dictionary<int, IntPtr>();
    static IntPtr TraversalWindow;
    static IntPtr ObservedWindow = IntPtr.Zero;
    static Rectangle ObservedBounds;
    static DateTime ObservedAt;
    static bool ObservationConsumed = true;
    static string InstallRoot;
    static HashSet<string> Allow;
    static bool SelfTesting;
    static IntPtr FixtureWindow;
    static bool InputAttempted;
    static IntPtr ObservedForeground;
    static IntPtr ObservedFocus;
    static readonly HashSet<long> ObservedOwnedWindows = new HashSet<long>();
    static readonly Dictionary<string, Rectangle> ScreenshotRectangles = new Dictionary<string, Rectangle>();
    static readonly Dictionary<string, IntPtr> ScreenshotWindows = new Dictionary<string, IntPtr>();
    static List<MenuEntry> ObservedMenus = new List<MenuEntry>();
    sealed class MenuEntry
    {
        public int Index; public uint Command; public uint Position; public IntPtr Menu;
        public string Label; public string Path; public bool Enabled; public bool Checked; public bool Submenu; public bool Separator;
        public object Wire() { return new { menu_index = Index, commandId = Submenu || Separator ? (object)null : Command, label = Label, path = Path, enabled = Enabled, isChecked = Checked, submenu = Submenu, separator = Separator }; }
    }
    static List<MenuEntry> MenuItems(IntPtr hwnd)
    {
        var items = new List<MenuEntry>(); ReadMenu(GetMenu(hwnd), "", true, 0, items); return items;
    }
    static void ReadMenu(IntPtr menu, string prefix, bool parentEnabled, int depth, List<MenuEntry> items)
    {
        if (menu == IntPtr.Zero || depth > 10) return;
        int count = GetMenuItemCount(menu);
        for (int i = 0; i < count; i++)
        {
            if (items.Count >= 2000) throw new Exception("Native menu exceeds 2000 items.");
            var text = new StringBuilder(1024); GetMenuString(menu, (uint)i, text, text.Capacity, 0x400);
            uint state = GetMenuState(menu, (uint)i, 0x400); IntPtr child = GetSubMenu(menu, i);
            string itemPath = prefix.Length == 0 ? i.ToString() : prefix + "/" + i;
            var entry = new MenuEntry { Index = items.Count, Position = (uint)i, Menu = menu, Command = GetMenuItemID(menu, i), Label = text.ToString(), Path = itemPath, Enabled = parentEnabled && (state & 3) == 0, Checked = (state & 8) != 0, Submenu = child != IntPtr.Zero, Separator = (state & 0x800) != 0 };
            items.Add(entry); ReadMenu(child, itemPath, entry.Enabled, depth + 1, items);
        }
    }

    [MTAThread]
    static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        if (args.Length != 0) { Console.Error.WriteLine("Only --self-test is accepted; protocol is read from stdin."); return 2; }
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            object id = null;
            try
            {
                if (line.Length > 2 * 1024 * 1024) throw new Exception("Request exceeds 2 MiB limit.");
                var request = Json.DeserializeObject(line) as Dictionary<string, object>;
                if (request == null) throw new Exception("Request must be a JSON object.");
                if (request.ContainsKey("id")) id = request["id"];
                var result = Dispatch(request);
                Console.WriteLine(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "result", result } }));
            }
            catch (Exception ex)
            {
                Console.WriteLine(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "error", new { message = ex.Message } } }));
            }
        }
        return 0;
    }

    static object Dispatch(Dictionary<string, object> request)
    {
        string root = Str(request, "installRoot", null);
        if (!SelfTesting) ConfigureRoot(root);
        string method = Str(request, "method", null);
        var a = request.ContainsKey("args") ? request["args"] as Dictionary<string, object> : null;
        if (a == null) a = new Dictionary<string, object>();
        if (method == "status") return new { backend = "standalone-win32-uia", version = Version, interactiveSession = Environment.UserInteractive, inputDesktopAvailable = InputDesktopAvailable(), processArchitecture = IntPtr.Size == 8 ? "x64" : "x86", osArchitecture = Environment.Is64BitOperatingSystem ? "x64" : "x86", sessionId = Process.GetCurrentProcess().SessionId, coordinateSystem = "window-relative-physical-pixels", inputStructSize = Marshal.SizeOf(typeof(INPUT)), observationTtlMs = 120000, requiresHostTools = false };
        if (method == "windows") return new { windows = Windows() };
        if (method == "launch") return Launch(a);
        if (method == "observe") return Observe(WindowId(a), Bool(a, "includeScreenshot", true), Bool(a, "includeText", true));
        if (method == "action") return Action(WindowId(a), Str(a, "action", null), Dict(a, "parameters"));
        throw new Exception("Unknown method. Use status/windows/launch/observe/action.");
    }

    static void ConfigureRoot(string root)
    {
        if (String.IsNullOrWhiteSpace(root)) throw new Exception("installRoot is required.");
        string canonical = FinalPath(root, true).TrimEnd('\\');
        if (InstallRoot != null && !String.Equals(canonical, InstallRoot, StringComparison.OrdinalIgnoreCase)) throw new Exception("Worker installation cannot change; start a new worker.");
        if (InstallRoot != null) return;
        var allow = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string file in Programs)
        {
            string candidate = Path.Combine(canonical, file);
            if (File.Exists(candidate))
            {
                string resolved = FinalPath(candidate, false);
                if (String.Equals(Path.GetDirectoryName(resolved), canonical, StringComparison.OrdinalIgnoreCase)) allow.Add(resolved);
            }
        }
        if (!allow.Contains(Path.Combine(canonical, "max2win.exe"))) throw new Exception("Installation must contain a direct max2win.exe file.");
        InstallRoot = canonical; Allow = allow;
    }

    static string FinalPath(string value, bool directory)
    {
        IntPtr h = CreateFile(Path.GetFullPath(value), 0, 7, IntPtr.Zero, 3, directory ? 0x02000000u : 0u, IntPtr.Zero);
        if (h == new IntPtr(-1)) throw new Exception("Cannot resolve installation path: " + Marshal.GetLastWin32Error());
        try
        {
            var sb = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(h, sb, (uint)sb.Capacity, 0);
            if (length == 0 || length >= sb.Capacity) throw new Exception("Cannot canonicalize path.");
            string p = sb.ToString();
            if (p.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + p.Substring(8);
            return p.StartsWith("\\\\?\\", StringComparison.Ordinal) ? p.Substring(4) : p;
        }
        finally { CloseHandle(h); }
    }

    static uint Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
    static string Exe(uint pid)
    {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return null;
        try { var sb = new StringBuilder(32768); int size = sb.Capacity; return QueryFullProcessImageName(handle, 0, sb, ref size) ? FinalPath(sb.ToString(), false) : null; }
        catch { return null; }
        finally { CloseHandle(handle); }
    }
    static bool AllowedWindow(IntPtr hwnd)
    {
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return false;
        if (SelfTesting) return hwnd == FixtureWindow || IsChild(FixtureWindow, hwnd) || IsOwnedBy(hwnd, FixtureWindow) || IsActiveMenuFor(hwnd, FixtureWindow);
        string exe = Exe(Pid(hwnd)); return exe != null && Allow.Contains(exe);
    }
    static bool IsOwnedBy(IntPtr window, IntPtr owner)
    {
        for (int i = 0; window != IntPtr.Zero && i < 24; i++) { if (window == owner) return true; window = GetWindow(window, 4); }
        return false;
    }
    static bool InputDesktopAvailable()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
        if (desktop == IntPtr.Zero) return false;
        return CloseDesktop(desktop);
    }
    static IntPtr FocusWindow(IntPtr hwnd)
    {
        uint ignored; uint thread = GetWindowThreadProcessId(hwnd, out ignored);
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
        return GetGUIThreadInfo(thread, ref info) ? info.hwndFocus : IntPtr.Zero;
    }
    static Rectangle Bounds(IntPtr hwnd)
    {
        RECT r; if (!GetWindowRect(hwnd, out r)) throw new Exception("Cannot read window bounds.");
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }
    static object BoundsObject(Rectangle r) { return new { x = r.X, y = r.Y, width = r.Width, height = r.Height }; }
    static object WindowInfo(IntPtr hwnd)
    {
        RequireWindow(hwnd); var title = new StringBuilder(2048); GetWindowText(hwnd, title, title.Capacity);
        return new { id = hwnd.ToInt64(), app = "process:" + (SelfTesting ? Process.GetCurrentProcess().MainModule.FileName : Exe(Pid(hwnd))), title = title.ToString(), pid = Pid(hwnd), bounds = BoundsObject(Bounds(hwnd)), minimized = IsIconic(hwnd) };
    }
    static List<object> Windows()
    {
        var windows = new List<object>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) { try { if (AllowedWindow(hwnd)) windows.Add(WindowInfo(hwnd)); } catch { } return true; }, IntPtr.Zero);
        return windows;
    }
    static void RequireWindow(IntPtr hwnd)
    {
        if (!AllowedWindow(hwnd)) throw new Exception("Window is closed or is not an allowed MAX+plus II window.");
        if (IsHungAppWindow(hwnd)) throw new Exception("Target window is not responding; do not send more input.");
    }
    static object Launch(Dictionary<string, object> a)
    {
        string program = Str(a, "program", "max2win.exe");
        if (Array.IndexOf(Programs, program) < 0 || !Allow.Contains(Path.Combine(InstallRoot, program))) throw new Exception("Program is not an installed allowlisted MAX+plus II executable.");
        ObservationConsumed = true;
        int pid;
        using (var p = Process.Start(new ProcessStartInfo(Path.Combine(InstallRoot, program)) { UseShellExecute = false, WorkingDirectory = InstallRoot })) { pid = p.Id; }
        return new { launched = program, pid = pid, readinessVerified = false, next = "List windows and observe; process start does not prove readiness." };
    }

    static object Observe(IntPtr hwnd, bool screenshot, bool text)
    {
        RequireWindow(hwnd); ObservationConsumed = true; Elements.Clear(); ElementBounds.Clear(); ElementWindows.Clear(); ScreenshotRectangles.Clear(); ScreenshotWindows.Clear();
        var ownedWindows = OwnedWindowIds(hwnd);
        var r = Bounds(hwnd); var tree = new StringBuilder(); var nodes = new List<object>(); var errors = new List<string>();
        bool truncated = false; var clock = Stopwatch.StartNew();
        object focused = null;
        if (text)
        {
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                TraversalWindow = hwnd;
                Walk(root, 0, r, tree, nodes, clock, ref truncated);
                foreach (long popup in ownedWindows)
                {
                    IntPtr popupWindow = new IntPtr(popup);
                    if (!AllowedWindow(popupWindow)) continue;
                    try { TraversalWindow = popupWindow; Walk(AutomationElement.FromHandle(popupWindow), 0, r, tree, nodes, clock, ref truncated); }
                    catch (Exception ex) { errors.Add("Owned window accessibility unavailable: " + ex.Message); }
                }
                var focus = AutomationElement.FocusedElement;
                if (focus != null && focus.Current.ProcessId == Pid(hwnd))
                {
                    int found = -1;
                    foreach (var pair in Elements) { if (Automation.Compare(pair.Value, focus)) { found = pair.Key; break; } }
                    focused = new { element_index = found, name = SafeName(focus), controlType = focus.Current.ControlType.ProgrammaticName, hasKeyboardFocus = focus.Current.HasKeyboardFocus, patterns = PatternNames(focus) };
                }
            }
            catch (Exception ex) { errors.Add("Accessibility partially unavailable: " + ex.Message); }
        }
        IntPtr win32Focus = FocusWindow(hwnd);
        if (focused == null && win32Focus != IntPtr.Zero && Pid(win32Focus) == Pid(hwnd) && (win32Focus == hwnd || IsChild(hwnd, win32Focus)))
        {
            var name = new StringBuilder(512); GetWindowText(win32Focus, name, name.Capacity);
            focused = new { element_index = -1, name = name.ToString(), source = "Win32.GetGUIThreadInfo", hwnd = win32Focus.ToInt64(), hasKeyboardFocus = true };
        }
        var shots = new List<object>();
        if (screenshot)
        {
            try { shots.Add(Capture(hwnd, r, "screenshot-0", 0, 0, 0)); ScreenshotRectangles["screenshot-0"] = r; ScreenshotWindows["screenshot-0"] = hwnd; } catch (Exception ex) { errors.Add("Screenshot unavailable: " + ex.Message); }
            foreach (long popup in ownedWindows)
            {
                IntPtr popupWindow = new IntPtr(popup); if (!AllowedWindow(popupWindow)) continue;
                try { Rectangle pr = Bounds(popupWindow); int i = shots.Count; string id = "screenshot-" + popup; shots.Add(Capture(popupWindow, pr, id, pr.X - r.X, pr.Y - r.Y, i)); ScreenshotRectangles[id] = pr; ScreenshotWindows[id] = popupWindow; }
                catch (Exception ex) { errors.Add("Owned popup screenshot unavailable: " + ex.Message); }
            }
        }
        try { ObservedMenus = MenuItems(hwnd); } catch (Exception ex) { ObservedMenus.Clear(); errors.Add("Menu inventory unavailable: " + ex.Message); }
        var menuRows = new List<object>(); foreach (var menu in ObservedMenus) menuRows.Add(menu.Wire());
        ObservedWindow = hwnd; ObservedBounds = r; ObservedAt = DateTime.UtcNow; ObservationConsumed = false; ObservedForeground = GetForegroundWindow(); ObservedFocus = win32Focus;
        ObservedOwnedWindows.Clear(); foreach (long owned in ownedWindows) ObservedOwnedWindows.Add(owned);
        return new { window = WindowInfo(hwnd), accessibility = new { tree = tree.ToString(), elements = nodes, focused_element = focused, truncated = truncated, maxElements = 1500, maxDepth = 20 }, menus = menuRows, screenshots = shots, backend = "standalone-win32-uia", coordinateSystem = "window-relative-physical-pixels", warnings = errors, observationTtlMs = 120000 };
    }
    static void Walk(AutomationElement element, int depth, Rectangle window, StringBuilder tree, List<object> nodes, Stopwatch clock, ref bool truncated)
    {
        if (element == null) return;
        if (depth > 20 || Elements.Count >= 1500 || clock.ElapsedMilliseconds > 3500) { truncated = true; return; }
        try
        {
            int index = Elements.Count; var c = element.Current; var b = c.BoundingRectangle;
            Rectangle absolute = b.IsEmpty ? Rectangle.Empty : Rectangle.FromLTRB((int)b.Left, (int)b.Top, (int)Math.Ceiling(b.Right), (int)Math.Ceiling(b.Bottom));
            Rectangle relative = absolute.IsEmpty ? Rectangle.Empty : new Rectangle(absolute.X - window.X, absolute.Y - window.Y, absolute.Width, absolute.Height);
            Elements[index] = element; ElementBounds[index] = absolute; ElementWindows[index] = TraversalWindow;
            string name = SafeName(element); var patterns = PatternNames(element);
            var secondary = SecondaryActions(patterns);
            object value = null; bool valueTruncated = false;
            object pattern;
            if (!c.IsPassword && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) { try { string actual = ((ValuePattern)pattern).Current.Value; valueTruncated = actual != null && actual.Length > 2048; value = valueTruncated ? actual.Substring(0, 2048) : actual; } catch { } }
            tree.Append(' ', depth * 2).Append(index).Append(" ").Append(c.ControlType.ProgrammaticName).Append(" \"").Append(name.Replace("\"", "'" )).Append("\" [").Append(relative.X).Append(',').Append(relative.Y).Append(',').Append(relative.Width).Append(',').Append(relative.Height).Append("]");
            if (c.HasKeyboardFocus) tree.Append(" focused"); if (!c.IsEnabled) tree.Append(" disabled");
            if (c.IsOffscreen) tree.Append(" offscreen"); if (secondary.Count > 0) tree.Append(" actions=" + String.Join(",", secondary)); tree.AppendLine();
            nodes.Add(new { element_index = index, name = name, controlType = c.ControlType.ProgrammaticName, automationId = Limited(c.AutomationId, 256), className = Limited(c.ClassName, 256), bounds = BoundsObject(relative), enabled = c.IsEnabled, offscreen = c.IsOffscreen, focused = c.HasKeyboardFocus, password = c.IsPassword, patterns = patterns, secondaryActions = secondary, value = value, valueTruncated = valueTruncated });
            var child = TreeWalker.RawViewWalker.GetFirstChild(element);
            while (child != null)
            {
                if (clock.ElapsedMilliseconds > 3500 || Elements.Count >= 1500) { truncated = true; break; }
                Walk(child, depth + 1, window, tree, nodes, clock, ref truncated);
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
        }
        catch (ElementNotAvailableException) { truncated = true; }
        catch (InvalidOperationException) { truncated = true; }
    }
    static string SafeName(AutomationElement e) { string s = e.Current.Name ?? ""; if (s.Length > 512) s = s.Substring(0, 512); return s.Replace('\r', ' ').Replace('\n', ' '); }
    static string Limited(string value, int length) { return value == null || value.Length <= length ? value : value.Substring(0, length); }
    static List<string> PatternNames(AutomationElement e)
    {
        var list = new List<string>(); foreach (var p in e.GetSupportedPatterns()) list.Add(p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "").Replace("Identifiers.Pattern", "")); return list;
    }
    static List<string> SecondaryActions(List<string> patterns)
    {
        var list = new List<string>(); foreach (string p in patterns)
        {
            if (p.IndexOf("Invoke", StringComparison.OrdinalIgnoreCase) >= 0) list.Add("Invoke");
            if (p.IndexOf("ExpandCollapse", StringComparison.OrdinalIgnoreCase) >= 0) { list.Add("Expand"); list.Add("Collapse"); }
            if (p.IndexOf("SelectionItem", StringComparison.OrdinalIgnoreCase) >= 0) list.Add("Select");
            if (p.IndexOf("Toggle", StringComparison.OrdinalIgnoreCase) >= 0) list.Add("Toggle");
        }
        return list;
    }
    static object Capture(IntPtr hwnd, Rectangle r, string id, int originX, int originY, int zIndex)
    {
        if (IsIconic(hwnd)) throw new Exception("Minimized window cannot provide a reliable screenshot; activate it and observe again.");
        if (r.Width < 1 || r.Height < 1 || (long)r.Width * r.Height > 16000000) throw new Exception("Screenshot dimensions exceed 16 million physical pixels.");
        string source = "PrintWindow"; bool mayBeOccluded = false; bool blank;
        using (var bitmap = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb))
        {
            bool printed;
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.Black); IntPtr dc = graphics.GetHdc();
                try { printed = PrintWindow(hwnd, dc, 2); if (!printed) printed = PrintWindow(hwnd, dc, 0); }
                finally { graphics.ReleaseHdc(dc); }
            }
            blank = LooksBlank(bitmap);
            if (!printed || blank)
            {
                source = "visible-desktop-crop"; mayBeOccluded = true;
                using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(r.Location, Point.Empty, r.Size, CopyPixelOperation.SourceCopy);
                blank = LooksBlank(bitmap);
            }
            using (var buffer = new MemoryStream())
            {
                bitmap.Save(buffer, ImageFormat.Png);
                if (buffer.Length > 6 * 1024 * 1024) throw new Exception("PNG exceeds 8 MiB base64 budget; accessibility is still available.");
                return new { id = id, width = r.Width, height = r.Height, originX = originX, originY = originY, zIndex = zIndex, url = "data:image/png;base64," + Convert.ToBase64String(buffer.ToArray()), captureSource = source, mayBeOccluded = mayBeOccluded, possiblyBlank = blank, pixelScale = 1, quality = blank ? "possibly-blank" : mayBeOccluded ? "visible-pixels-may-include-overlays" : "window-rendered-pixels" };
            }
        }
    }
    static bool LooksBlank(Bitmap b)
    {
        int first = b.GetPixel(b.Width / 2, b.Height / 2).ToArgb();
        for (int x = 1; x < 8; x++) for (int y = 1; y < 8; y++) if (b.GetPixel((b.Width - 1) * x / 8, (b.Height - 1) * y / 8).ToArgb() != first) return false;
        return true;
    }

    static object Action(IntPtr hwnd, string action, Dictionary<string, object> p)
    {
        RequireWindow(hwnd);
        if (ObservationConsumed || ObservedWindow != hwnd || DateTime.UtcNow.Subtract(ObservedAt).TotalMilliseconds > 120000) throw new Exception("Observation is missing, consumed, or expired; observe again.");
        if (Bounds(hwnd) != ObservedBounds) throw new Exception("Window moved/resized after observation; observe again.");
        if (!ObservedOwnedWindows.SetEquals(OwnedWindowIds(hwnd))) throw new Exception("Owned/dialog window set changed after observation; list windows and observe again.");
        foreach (int vk in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) throw new Exception("A physical modifier is held; release it and observe before input.");
        IntPtr currentForeground = GetForegroundWindow();
        if (currentForeground != ObservedForeground && currentForeground != hwnd && Pid(currentForeground) == Pid(hwnd) && IsOwnedBy(currentForeground, hwnd)) throw new Exception("A new owned/modal window appeared; list windows and observe that window before input.");
        if (!IsWindowEnabled(hwnd) && action != "activate_window") throw new Exception("Window is disabled by a modal dialog; observe the enabled dialog instead.");
        ObservationConsumed = true; InputAttempted = false;
        var heldModifiers = new List<ushort>();
        try
        {
            if (action == "activate_window") { Activate(hwnd); return new { action = action, inputDelivered = true, verificationRequired = true }; }
            Activate(hwnd);
            if (action == "click" || action == "drag" || action == "scroll" || action == "move")
            {
                foreach (ushort modifier in MouseModifiers(p)) { GuardForeground(hwnd); Key(modifier, 0, 0); heldModifiers.Add(modifier); }
                if (heldModifiers.Count > 0) Thread.Sleep(25);
            }
            if (action == "click")
            {
                Point point = p.ContainsKey("element_index") ? ElementPoint(hwnd, Integer(p, "element_index")) : Coordinate(hwnd, Number(p, "x"), Number(p, "y"), Str(p, "screenshotId", null));
                GuardPoint(hwnd, point); Move(point);
                string button = Str(p, "mouse_button", "left"); int count = p.ContainsKey("click_count") ? Integer(p, "click_count") : 1;
                if (count != 1 && count != 2) throw new Exception("click_count must be 1 or 2.");
                uint down, up; ButtonFlags(button, out down, out up);
                for (int i = 0; i < count; i++) { GuardForeground(hwnd); try { Mouse(down, 0); } finally { Mouse(up, 0); } if (i == 0 && count == 2) Thread.Sleep(70); }
            }
            else if (action == "invoke_menu")
            {
                int index = Integer(p, "menu_index"); if (index >= ObservedMenus.Count) throw new Exception("Menu index was not observed.");
                var selected = ObservedMenus[index]; if (!selected.Enabled || selected.Submenu || selected.Separator) throw new Exception("Menu is not an enabled leaf command.");
                var current = MenuItems(hwnd); if (index >= current.Count) throw new Exception("Menu changed; observe again.");
                var actual = current[index];
                if (actual.Path != selected.Path || actual.Menu != selected.Menu || actual.Command != selected.Command || actual.Label != selected.Label || !actual.Enabled || actual.Submenu || actual.Separator) throw new Exception("Menu changed or was disabled; observe again.");
                GuardForeground(hwnd); InputAttempted = true;
                var info = new MENUINFO { cbSize = (uint)Marshal.SizeOf(typeof(MENUINFO)), fMask = 0x10 };
                bool byPosition = GetMenuInfo(selected.Menu, ref info) && (info.dwStyle & 0x08000000) != 0;
                if (!PostMessage(hwnd, byPosition ? 0x126u : 0x111u, new UIntPtr(byPosition ? selected.Position : selected.Command), byPosition ? selected.Menu : IntPtr.Zero)) throw new Exception("Menu command delivery failed.");
                Thread.Sleep(80);
            }
            else if (action == "press_key") Chord(hwnd, Str(p, "key", null));
            else if (action == "type_text")
            {
                IntPtr focus = FocusWindow(hwnd);
                if (focus == IntPtr.Zero || Pid(focus) != Pid(hwnd) || !(focus == hwnd || IsChild(hwnd, focus)) || ObservedFocus != IntPtr.Zero && ObservedFocus != focus) throw new Exception("Observed target focus changed or is unavailable; observe again.");
                string value = Str(p, "text", null); if (value == null || value.Length > 20000) throw new Exception("text must be at most 20000 UTF-16 units.");
                foreach (char ch in value) { GuardForeground(hwnd); try { Key(0, ch, 4); } finally { Key(0, ch, 6); } }
            }
            else if (action == "set_value")
            {
                AutomationElement element = Indexed(hwnd, Integer(p, "element_index")); object pattern;
                if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly) throw new Exception("Element has no writable ValuePattern; use focused keyboard input.");
                string value = Str(p, "value", null); if (value == null || value.Length > 20000) throw new Exception("value must be at most 20000 UTF-16 units.");
                GuardForeground(hwnd); InputAttempted = true; ((ValuePattern)pattern).SetValue(value);
            }
            else if (action == "perform_secondary_action") Secondary(hwnd, Indexed(hwnd, Integer(p, "element_index")), Str(p, "action", null));
            else if (action == "drag")
            {
                Point start = Coordinate(hwnd, Number(p, "from_x"), Number(p, "from_y"), Str(p, "screenshotId", null)); Point end = Coordinate(hwnd, Number(p, "to_x"), Number(p, "to_y"), Str(p, "screenshotId", null));
                uint down, up; ButtonFlags(Str(p, "mouse_button", "left"), out down, out up);
                int duration = p.ContainsKey("durationMs") ? Integer(p, "durationMs") : 300; if (duration < 100 || duration > 5000) throw new Exception("durationMs must be 100..5000.");
                GuardPoint(hwnd, start); GuardPoint(hwnd, end); Move(start);
                try { Mouse(down, 0); for (int i = 1; i <= 20; i++) { GuardForeground(hwnd); Point current = new Point(start.X + (end.X - start.X) * i / 20, start.Y + (end.Y - start.Y) * i / 20); GuardPoint(hwnd, current); Move(current); Thread.Sleep(duration / 20); } }
                finally { Mouse(up, 0); }
            }
            else if (action == "scroll")
            {
                Point point = Coordinate(hwnd, Number(p, "x"), Number(p, "y"), Str(p, "screenshotId", null)); GuardPoint(hwnd, point); Move(point);
                double x = Number(p, "scrollX"), y = Number(p, "scrollY"); if (Math.Abs(x) > 120000 || Math.Abs(y) > 120000 || Math.Floor(x) != x || Math.Floor(y) != y) throw new Exception("Scroll delta must be integer wheel units within +/-120000.");
                GuardForeground(hwnd); if (y != 0) Mouse(0x0800, unchecked((uint)(int)Math.Round(-y))); if (x != 0) Mouse(0x1000, unchecked((uint)(int)Math.Round(x)));
            }
            else if (action == "move") { Point point = Coordinate(hwnd, Number(p, "x"), Number(p, "y"), Str(p, "screenshotId", null)); GuardPoint(hwnd, point); Move(point); }
            else throw new Exception("Unsupported action.");
            return new { action = action, inputDelivered = true, verificationRequired = true, observationConsumed = true };
        }
        catch (Exception ex) { throw new Exception((InputAttempted ? "Input outcome is uncertain; observe before retrying. " : "Input was not delivered. ") + ex.Message); }
        finally { if (heldModifiers.Count > 0 && InputAttempted) Thread.Sleep(60); for (int i = heldModifiers.Count - 1; i >= 0; i--) { try { Key(heldModifiers[i], 0, 2); } catch (Exception ex) { Console.Error.WriteLine("Modifier release failed: " + ex.Message); } } }
    }
    static HashSet<long> OwnedWindowIds(IntPtr hwnd)
    {
        var windows = new HashSet<long>(); uint pid = Pid(hwnd);
        EnumWindows(delegate(IntPtr w, IntPtr data) { if (IsWindowVisible(w) && Pid(w) == pid && w != hwnd && (IsOwnedBy(w, hwnd) || IsActiveMenuFor(w, hwnd))) windows.Add(w.ToInt64()); return true; }, IntPtr.Zero); return windows;
    }
    static bool IsActiveMenuFor(IntPtr menu, IntPtr owner)
    {
        var name = new StringBuilder(256); GetClassName(menu, name, name.Capacity); if (name.ToString() != "#32768") return false;
        uint ignored; uint menuThread = GetWindowThreadProcessId(menu, out ignored); uint ownerThread = GetWindowThreadProcessId(owner, out ignored); if (menuThread != ownerThread) return false;
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
        return GetGUIThreadInfo(menuThread, ref info) && info.hwndMenuOwner != IntPtr.Zero && (info.hwndMenuOwner == owner || IsChild(owner, info.hwndMenuOwner));
    }
    static List<ushort> MouseModifiers(Dictionary<string, object> p)
    {
        var result = new List<ushort>(); object value; if (!p.TryGetValue("modifiers", out value)) return result;
        var list = value as object[]; if (list == null || list.Length > 3) throw new Exception("modifiers must be an array of Ctrl/Alt/Shift.");
        foreach (object item in list) { string name = item as string; ushort k = name == "Ctrl" ? (ushort)0x11 : name == "Alt" ? (ushort)0x12 : name == "Shift" ? (ushort)0x10 : (ushort)0; if (k == 0 || result.Contains(k)) throw new Exception("Invalid/duplicate modifier."); result.Add(k); }
        return result;
    }
    static void Activate(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        uint ignored; uint targetThread = GetWindowThreadProcessId(hwnd, out ignored); uint ownThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        bool attachedForeground = foregroundThread != 0 && foregroundThread != ownThread && foregroundThread != targetThread && AttachThreadInput(ownThread, foregroundThread, true);
        bool attached = targetThread != ownThread && AttachThreadInput(ownThread, targetThread, true);
        try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
        finally { if (attached) AttachThreadInput(ownThread, targetThread, false); if (attachedForeground) AttachThreadInput(ownThread, foregroundThread, false); }
        Thread.Sleep(40); GuardForeground(hwnd);
    }
    static void GuardForeground(IntPtr hwnd)
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero || Pid(foreground) != Pid(hwnd) || !(foreground == hwnd || ObservedOwnedWindows.Contains(foreground.ToInt64()) && (IsOwnedBy(foreground, hwnd) || IsActiveMenuFor(foreground, hwnd)) || foreground == ObservedForeground && IsActiveMenuFor(hwnd, foreground))) throw new Exception("Target lost foreground focus or an unobserved owned window appeared; input stopped.");
    }
    static void GuardPoint(IntPtr hwnd, Point point)
    {
        GuardForeground(hwnd); IntPtr hit = WindowFromPoint(new POINT { X = point.X, Y = point.Y });
        if (hit == IntPtr.Zero || Pid(hit) != Pid(hwnd)) throw new Exception("Point is covered by another application; input stopped.");
        IntPtr top = GetAncestor(hit, 2); if (!(top == hwnd || ObservedOwnedWindows.Contains(top.ToInt64()) && (IsOwnedBy(top, hwnd) || IsActiveMenuFor(top, hwnd)))) throw new Exception("Point belongs to another/unobserved top-level target window; observe that window instead.");
    }
    static Point Coordinate(IntPtr hwnd, double x, double y, string screenshotId)
    {
        Rectangle screenshot; IntPtr source;
        if (screenshotId == null || !ScreenshotRectangles.TryGetValue(screenshotId, out screenshot) || !ScreenshotWindows.TryGetValue(screenshotId, out source)) throw new Exception("Coordinate input requires screenshotId from latest observation.");
        if (!IsWindow(source) || Bounds(source) != screenshot) throw new Exception("Screenshot source moved or closed; observe again.");
        if (source != hwnd && !ObservedOwnedWindows.Contains(source.ToInt64())) throw new Exception("Screenshot belongs to an unobserved popup.");
        Rectangle r = Bounds(hwnd); if (x < Int32.MinValue / 2 || x > Int32.MaxValue / 2 || y < Int32.MinValue / 2 || y > Int32.MaxValue / 2) throw new Exception("Coordinate out of range.");
        Point point = new Point(r.X + (int)Math.Round(x), r.Y + (int)Math.Round(y));
        if (!screenshot.Contains(point)) throw new Exception("Coordinates are outside their observed screenshot bounds."); return point;
    }
    static AutomationElement Indexed(IntPtr hwnd, int index)
    {
        AutomationElement element; if (!Elements.TryGetValue(index, out element)) throw new Exception("Element index is not in the latest observation.");
        var current = element.Current; if (current.ProcessId != Pid(hwnd) || !current.IsEnabled) throw new Exception("Element is unavailable or disabled.");
        IntPtr elementWindow = ElementWindows[index]; if (elementWindow != hwnd && !ObservedOwnedWindows.Contains(elementWindow.ToInt64())) throw new Exception("Element does not belong to an observed window.");
        if (!IsWindow(elementWindow)) throw new Exception("Element's owning window closed; observe again.");
        var root = AutomationElement.FromHandle(elementWindow); var ancestor = element; bool inTree = false;
        for (int i = 0; ancestor != null && i < 64; i++) { if (Automation.Compare(root, ancestor)) { inTree = true; break; } ancestor = TreeWalker.RawViewWalker.GetParent(ancestor); }
        if (!inTree) throw new Exception("Element left the observed window tree; observe again.");
        var b = current.BoundingRectangle;
        Rectangle r = b.IsEmpty ? Rectangle.Empty : Rectangle.FromLTRB((int)b.Left, (int)b.Top, (int)Math.Ceiling(b.Right), (int)Math.Ceiling(b.Bottom));
        if (r != ElementBounds[index]) throw new Exception("Element moved since observation; observe again.");
        return element;
    }
    static Point ElementPoint(IntPtr hwnd, int index)
    {
        var element = Indexed(hwnd, index); if (element.Current.IsOffscreen) throw new Exception("Element is offscreen.");
        System.Windows.Point p;
        if (element.TryGetClickablePoint(out p)) return new Point((int)Math.Round(p.X), (int)Math.Round(p.Y));
        Rectangle r = ElementBounds[index]; if (r.Width < 1 || r.Height < 1) throw new Exception("Element has no clickable bounds; use a screenshot coordinate.");
        return new Point(r.X + r.Width / 2, r.Y + r.Height / 2);
    }
    static void Secondary(IntPtr hwnd, AutomationElement element, string action)
    {
        object pattern; GuardForeground(hwnd);
        if (String.Equals(action, "Invoke", StringComparison.OrdinalIgnoreCase) && element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { InputAttempted = true; ((InvokePattern)pattern).Invoke(); }
        else if ((String.Equals(action, "Expand", StringComparison.OrdinalIgnoreCase) || String.Equals(action, "Collapse", StringComparison.OrdinalIgnoreCase)) && element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { InputAttempted = true; if (String.Equals(action, "Expand", StringComparison.OrdinalIgnoreCase)) ((ExpandCollapsePattern)pattern).Expand(); else ((ExpandCollapsePattern)pattern).Collapse(); }
        else if (String.Equals(action, "Select", StringComparison.OrdinalIgnoreCase) && element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { InputAttempted = true; ((SelectionItemPattern)pattern).Select(); }
        else if (String.Equals(action, "Toggle", StringComparison.OrdinalIgnoreCase) && element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { InputAttempted = true; ((TogglePattern)pattern).Toggle(); }
        else throw new Exception("Requested secondary action is not an available documented UIA pattern.");
    }
    static void Chord(IntPtr hwnd, string chord)
    {
        if (String.IsNullOrWhiteSpace(chord) || chord.Length > 100) throw new Exception("A single key/chord is required.");
        string[] parts = chord.Split('+'); var modifiers = new List<ushort>();
        for (int i = 0; i < parts.Length - 1; i++)
        {
            string s = parts[i].Trim().ToLowerInvariant().Replace("_l", "").Replace("_r", ""); ushort k = s == "ctrl" || s == "control" ? (ushort)0x11 : s == "alt" ? (ushort)0x12 : s == "shift" ? (ushort)0x10 : (ushort)0;
            if (k == 0 || modifiers.Contains(k)) throw new Exception("Only Ctrl/Alt/Shift modifiers are accepted."); modifiers.Add(k);
        }
        ushort key = VirtualKey(parts[parts.Length - 1].Trim());
        if (key == 0x5B || key == 0x5C) throw new Exception("Windows/system keys are not accepted.");
        // Global task switching or secure attention leaves the scoped application.
        if ((key == 9 || key == 0x1B) && modifiers.Contains(0x12) || key == 0x2E && modifiers.Contains(0x11) && modifiers.Contains(0x12)) throw new Exception("Global task-switch/secure-attention chords are not accepted.");
        var held = new List<ushort>();
        try { foreach (ushort modifier in modifiers) { GuardForeground(hwnd); Key(modifier, 0, 0); held.Add(modifier); } GuardForeground(hwnd); try { Key(key, 0, Extended(key)); } finally { Key(key, 0, Extended(key) | 2); } }
        finally { for (int i = held.Count - 1; i >= 0; i--) Key(held[i], 0, 2); }
    }
    static ushort VirtualKey(string name)
    {
        if (name.Length == 1 && Char.IsLetterOrDigit(name[0])) return (ushort)Char.ToUpperInvariant(name[0]);
        string s = name.ToLowerInvariant().Replace("_l", "").Replace("_r", "").Replace("_", ""); int f; if (s.Length > 1 && s[0] == 'f' && Int32.TryParse(s.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6F + f);
        var keys = new Dictionary<string, ushort> { { "return", 13 }, { "enter", 13 }, { "tab", 9 }, { "escape", 27 }, { "esc", 27 }, { "space", 32 }, { "backspace", 8 }, { "delete", 46 }, { "insert", 45 }, { "home", 36 }, { "end", 35 }, { "left", 37 }, { "up", 38 }, { "right", 39 }, { "down", 40 }, { "pageup", 33 }, { "prior", 33 }, { "pagedown", 34 }, { "next", 34 }, { "apps", 0x5D }, { "menu", 0x5D }, { "add", 0x6B }, { "subtract", 0x6D }, { "multiply", 0x6A }, { "divide", 0x6F }, { "decimal", 0x6E }, { "plus", 0xBB }, { "minus", 0xBD }, { "comma", 0xBC }, { "period", 0xBE }, { "slash", 0xBF }, { "semicolon", 0xBA }, { "equal", 0xBB }, { "bracketleft", 0xDB }, { "bracketright", 0xDD }, { "backslash", 0xDC }, { "apostrophe", 0xDE }, { "grave", 0xC0 } };
        if (s == "ctrl" || s == "control") return 0x11; if (s == "shift") return 0x10; if (s == "alt") return 0x12;
        ushort result; if (!keys.TryGetValue(s, out result)) throw new Exception("Unsupported key name: " + name); return result;
    }
    static uint Extended(ushort key) { return key >= 0x21 && key <= 0x2E || key == 0x6F || key == 0x5D ? 1u : 0u; }
    static void ButtonFlags(string button, out uint down, out uint up)
    {
        if (button == "left" || button == "l") { down = 2; up = 4; }
        else if (button == "right" || button == "r") { down = 8; up = 16; }
        else if (button == "middle" || button == "m") { down = 32; up = 64; }
        else throw new Exception("Unknown mouse button.");
    }
    static void Move(Point p)
    {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        int x = (int)Math.Round((p.X - left) * 65535.0 / Math.Max(1, width - 1)); int y = (int)Math.Round((p.Y - top) * 65535.0 / Math.Max(1, height - 1));
        Send(new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dx = x, dy = y, dwFlags = 0x8001 | 0x4000 } } });
    }
    static void Mouse(uint flags, uint data) { Send(new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { dwFlags = flags, mouseData = data } } }); }
    static void Key(ushort key, ushort scan, uint flags) { Send(new INPUT { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { wVk = key, wScan = scan, dwFlags = flags } } }); }
    static void Send(INPUT input)
    {
        InputAttempted = true;
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput failed/blocked, Win32 error " + Marshal.GetLastWin32Error() + "; target and helper must have compatible integrity levels.");
    }
    static string Str(Dictionary<string, object> a, string key, string fallback) { object value; if (!a.TryGetValue(key, out value)) return fallback; if (!(value is string)) throw new Exception(key + " must be a string."); return (string)value; }
    static bool Bool(Dictionary<string, object> a, string key, bool fallback) { object v; if (!a.TryGetValue(key, out v)) return fallback; if (!(v is bool)) throw new Exception(key + " must be a boolean."); return (bool)v; }
    static double Number(Dictionary<string, object> a, string key) { object value; if (!a.TryGetValue(key, out value) || !(value is int || value is long || value is double || value is decimal)) throw new Exception(key + " must be a number."); double d = Convert.ToDouble(value); if (Double.IsNaN(d) || Double.IsInfinity(d)) throw new Exception(key + " must be finite."); return d; }
    static int Integer(Dictionary<string, object> a, string key) { double value = Number(a, key); if (value < 0 || value > Int32.MaxValue || Math.Floor(value) != value) throw new Exception(key + " must be a nonnegative integer."); return (int)value; }
    static IntPtr WindowId(Dictionary<string, object> a) { double v = Number(a, "windowId"); if (v <= 0 || v > 9007199254740991 || Math.Floor(v) != v) throw new Exception("windowId must be a positive safe integer."); return new IntPtr((long)v); }
    static Dictionary<string, object> Dict(Dictionary<string, object> a, string key) { object v; if (!a.TryGetValue(key, out v)) return new Dictionary<string, object>(); var d = v as Dictionary<string, object>; if (d == null) throw new Exception(key + " must be an object."); return d; }

    static int SelfTest()
    {
        SelfTesting = true; var checks = new List<object>(); int passed = 0, failed = 0;
        IntPtr originalForeground = GetForegroundWindow(); POINT originalCursor; GetCursorPos(out originalCursor);
        bool cursorRestored = false, foregroundRestored = false;
        Form form = null; TextBox edit = null; Button button = null; Panel panel = null; CheckBox toggle = null;
        int clicks = 0, drags = 0, moves = 0, wheels = 0, shortcut = 0, menuClicks = 0; bool mouseDown = false; bool shiftClick = false;
        var ready = new ManualResetEvent(false); Exception fixtureError = null;
        var thread = new Thread(delegate()
        {
            try
            {
                form = new Form { Text = "MAXPLUS MCP isolated native self-test", StartPosition = FormStartPosition.Manual, Location = new Point(140, 140), Size = new Size(640, 400), KeyPreview = true };
                edit = new TextBox { Name = "FixtureText", AccessibleName = "FixtureText", Location = new Point(20, 25), Size = new Size(450, 30) };
                button = new Button { Name = "FixtureButton", AccessibleName = "FixtureButton", Text = "Fixture button", Location = new Point(20, 80), Size = new Size(150, 40) };
                panel = new Panel { Name = "FixtureDrag", AccessibleName = "FixtureDrag", Location = new Point(20, 145), Size = new Size(430, 130), BackColor = Color.LightSteelBlue, TabStop = true };
                toggle = new CheckBox { Name = "FixtureToggle", AccessibleName = "FixtureToggle", Text = "Toggle", Location = new Point(230, 80), Size = new Size(120, 35) };
                form.Controls.AddRange(new Control[] { edit, button, panel, toggle });
                form.Menu = new MainMenu(new MenuItem[] { new MenuItem("Fixture commands", new MenuItem[] { new MenuItem("Native command", delegate { Interlocked.Increment(ref menuClicks); }) }) });
                button.Click += delegate { Interlocked.Increment(ref clicks); };
                button.MouseDown += delegate { shiftClick = (Control.ModifierKeys & Keys.Shift) != 0; };
                panel.MouseDown += delegate { mouseDown = true; panel.Focus(); };
                panel.MouseMove += delegate { if (mouseDown) Interlocked.Increment(ref moves); };
                panel.MouseUp += delegate { if (mouseDown) Interlocked.Increment(ref drags); mouseDown = false; };
                panel.MouseWheel += delegate { Interlocked.Increment(ref wheels); };
                form.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.Control && e.KeyCode == Keys.K) { Interlocked.Increment(ref shortcut); e.Handled = true; e.SuppressKeyPress = true; } };
                form.Shown += delegate { FixtureWindow = form.Handle; edit.Focus(); ready.Set(); };
                Application.Run(form);
            }
            catch (Exception ex) { fixtureError = ex; ready.Set(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.IsBackground = true; thread.Start();
        System.Action<string, System.Action> check = delegate(string name, System.Action run)
        {
            try { run(); passed++; checks.Add(new { name = name, passed = true }); }
            catch (Exception ex) { failed++; checks.Add(new { name = name, passed = false, error = ex.Message }); }
        };
        try
        {
            if (!ready.WaitOne(10000) || fixtureError != null || FixtureWindow == IntPtr.Zero) throw new Exception("Fixture did not start: " + fixtureError);
            // The worker is normally spawned with STARTF_USESHOWWINDOW/SW_HIDE.
            // Explicitly show only this disposable fixture, never a user window.
            ShowWindow(FixtureWindow, 5);
            Activate(FixtureWindow); Thread.Sleep(100);
            check("JSON status and native INPUT layout", delegate { var status = Wire("status", null); if (Convert.ToInt32(status["inputStructSize"]) != (IntPtr.Size == 8 ? 40 : 28)) throw new Exception("Incorrect SendInput structure layout."); if (!(bool)status["inputDesktopAvailable"]) throw new Exception("Interactive input desktop unavailable."); });
            check("Only own fixture appears in enumeration", delegate { var status = Wire("windows", null); var rows = status["windows"] as object[]; if (rows == null || rows.Length != 1) throw new Exception("Unexpected fixture window enumeration."); });
            check("Observed native menu command and disabled-menu freshness", delegate {
                Fresh(); int index = -1; foreach (var m in ObservedMenus) if (m.Label == "Native command") index = m.Index;
                if (index < 0) throw new Exception("Fixture menu was not captured."); int prior = menuClicks; Do("invoke_menu", Args("menu_index", index)); Thread.Sleep(80); if (menuClicks != prior + 1) throw new Exception("Native menu was not invoked.");
                Fresh(); form.Invoke(new System.Action(delegate { form.Menu.MenuItems[0].MenuItems[0].Enabled = false; })); bool rejected = false;
                try { Do("invoke_menu", Args("menu_index", index)); } catch (Exception ex) { rejected = ex.Message.Contains("disabled") || ex.Message.Contains("changed"); }
                finally { form.Invoke(new System.Action(delegate { form.Menu.MenuItems[0].MenuItems[0].Enabled = true; })); }
                if (!rejected) throw new Exception("A disabled menu command was accepted.");
            });
            check("UIA tree and physical screenshot", delegate { var state = Wire("observe", Args("windowId", FixtureWindow.ToInt64())); var accessibility = (Dictionary<string, object>)state["accessibility"]; if (!((string)accessibility["tree"]).Contains("FixtureText")) throw new Exception("Text control missing from UIA."); var screenshots = state["screenshots"] as object[]; if (screenshots == null || screenshots.Length != 1 || !((string)((Dictionary<string, object>)screenshots[0])["url"]).StartsWith("data:image/png;base64,")) throw new Exception("PNG capture missing."); });
            check("UIA writable ValuePattern", delegate { Fresh(); int index = FindIndex("FixtureText"); Do("set_value", Args("element_index", index, "value", "ValuePattern test")); Thread.Sleep(80); if ((string)form.Invoke(new Func<string>(delegate { return edit.Text; })) != "ValuePattern test") throw new Exception("Value did not change."); });
            check("Indexed mouse click and Shift modifier release", delegate { Fresh(); int before = clicks; Do("click", Args("element_index", FindIndex("FixtureButton"), "modifiers", new object[] { "Shift" })); Thread.Sleep(80); if (clicks != before + 1 || !shiftClick || (GetAsyncKeyState(0x10) & 0x8000) != 0) throw new Exception("Click/modifier not delivered or modifier stuck."); });
            check("One observation cannot replay input", delegate { bool refused = false; try { Do("click", Args("element_index", FindIndex("FixtureButton"))); } catch (Exception ex) { refused = ex.Message.Contains("consumed"); } if (!refused) throw new Exception("Consumed observation was accepted."); });
            check("Unicode keyboard input and X11 chord aliases", delegate { form.Invoke(new System.Action(delegate { edit.Focus(); })); Fresh(); Do("press_key", Args("key", "Home")); Fresh(); Do("press_key", Args("key", "Shift_L+End")); Thread.Sleep(80); Fresh(); Do("type_text", Args("text", "中文 Ω unicode")); Thread.Sleep(150); string actual = (string)form.Invoke(new Func<string>(delegate { return edit.Text; })); if (actual != "中文 Ω unicode") throw new Exception("Unicode text differs: " + actual); Fresh(); Do("press_key", Args("key", "Control_R+k")); Thread.Sleep(80); if (shortcut != 1) throw new Exception("Control shortcut not delivered."); });
            check("Coordinate mouse drag", delegate { Rectangle r = (Rectangle)form.Invoke(new Func<Rectangle>(delegate { return panel.RectangleToScreen(panel.ClientRectangle); })); Rectangle w = Bounds(FixtureWindow); Fresh(); Do("drag", Args("from_x", r.X - w.X + 20, "from_y", r.Y - w.Y + 30, "to_x", r.X - w.X + 240, "to_y", r.Y - w.Y + 90, "durationMs", 250, "mouse_button", "left")); Thread.Sleep(80); if (drags != 1 || moves < 2) throw new Exception("Drag events missing."); });
            check("Hover move and wheel scroll", delegate { Rectangle r = (Rectangle)form.Invoke(new Func<Rectangle>(delegate { panel.Focus(); return panel.RectangleToScreen(panel.ClientRectangle); })); Rectangle w = Bounds(FixtureWindow); Fresh(); Do("move", Args("x", r.X - w.X + 80, "y", r.Y - w.Y + 60)); Fresh(); Do("scroll", Args("x", r.X - w.X + 80, "y", r.Y - w.Y + 60, "scrollX", 0, "scrollY", 120)); Thread.Sleep(100); if (wheels < 1) throw new Exception("Wheel event missing."); });
            check("UIA Toggle and Invoke secondary actions", delegate { Fresh(); Do("perform_secondary_action", Args("element_index", FindIndex("FixtureToggle"), "action", "Toggle")); Thread.Sleep(60); if (!(bool)form.Invoke(new Func<bool>(delegate { return toggle.Checked; }))) throw new Exception("Toggle pattern failed."); Fresh(); int before = clicks; Do("perform_secondary_action", Args("element_index", FindIndex("FixtureButton"), "action", "Invoke")); Thread.Sleep(120); if (clicks != before + 1) throw new Exception("Invoke pattern failed."); });
            check("Native menu popup tree, screenshot origin, and coordinate click", delegate
            {
                int priorMenuClicks = menuClicks;
                Rectangle main = Bounds(FixtureWindow);
                form.BeginInvoke(new System.Action(delegate
                {
                    IntPtr menu = CreatePopupMenu();
                    try { AppendMenu(menu, 0, new UIntPtr(1710), "Fixture native popup"); uint selected = TrackPopupMenuEx(menu, 0x100, main.Right - 20, main.Bottom - 30, FixtureWindow, IntPtr.Zero); if (selected == 1710) Interlocked.Increment(ref menuClicks); }
                    finally { DestroyMenu(menu); }
                }));
                Thread.Sleep(120); var state = Wire("observe", Args("windowId", FixtureWindow.ToInt64()));
                var shots = (object[])state["screenshots"]; if (shots.Length < 2) throw new Exception("Owned menu screenshot missing.");
                int index = FindIndex("Fixture native popup"); Rectangle element = ElementBounds[index]; string screenshot = null;
                foreach (object s in shots) { var shot = (Dictionary<string, object>)s; if ((string)shot["id"] != "screenshot-0") { screenshot = (string)shot["id"]; if (Convert.ToInt32(shot["originX"]) == 0) throw new Exception("Popup origin missing."); break; } }
                Do("click", Args("x", element.X - main.X + element.Width / 2, "y", element.Y - main.Y + element.Height / 2, "screenshotId", screenshot));
                Thread.Sleep(120); if (menuClicks != priorMenuClicks + 1) throw new Exception("Native menu selection did not complete.");
            });
            check("New owned dialog invalidates old observation", delegate { Fresh(); Form owned = null; form.Invoke(new System.Action(delegate { owned = new Form { Text = "Isolated owned fixture", Size = new Size(200, 130) }; owned.Show(form); })); Thread.Sleep(80); bool rejected = false; try { Do("press_key", Args("key", "Return")); } catch (Exception ex) { rejected = ex.Message.Contains("changed") || ex.Message.Contains("modal"); } finally { form.Invoke(new System.Action(delegate { owned.Close(); owned.Dispose(); })); } if (!rejected) throw new Exception("New owned window was accepted."); });
            check("Foreign HWND and system chords rejected", delegate { bool refused = false; try { Wire("observe", Args("windowId", 1)); } catch { refused = true; } if (!refused) throw new Exception("Foreign handle accepted."); Activate(FixtureWindow); Fresh(); refused = false; try { Do("press_key", Args("key", "Alt+Tab")); } catch { refused = true; } if (!refused) throw new Exception("Task switching accepted."); });
        }
        catch (Exception ex) { failed++; checks.Add(new { name = "Fixture initialization", passed = false, error = ex.Message }); }
        finally
        {
            try { if (form != null && !form.IsDisposed) form.Invoke(new System.Action(delegate { form.Close(); })); } catch { }
            thread.Join(3000); FixtureWindow = IntPtr.Zero;
            POINT afterCursor; cursorRestored = SetCursorPos(originalCursor.X, originalCursor.Y) && GetCursorPos(out afterCursor) && afterCursor.X == originalCursor.X && afterCursor.Y == originalCursor.Y;
            if (IsWindow(originalForeground))
            {
                uint ignored; uint t = GetWindowThreadProcessId(originalForeground, out ignored); uint self = GetCurrentThreadId(); uint active = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
                bool attachedActive = active != 0 && active != self && active != t && AttachThreadInput(self, active, true);
                bool attached = t != self && AttachThreadInput(self, t, true);
                try { SetForegroundWindow(originalForeground); } finally { if (attached) AttachThreadInput(self, t, false); if (attachedActive) AttachThreadInput(self, active, false); }
                foregroundRestored = GetForegroundWindow() == originalForeground;
            }
            else foregroundRestored = originalForeground == IntPtr.Zero;
        }
        Console.WriteLine(Json.Serialize(new { passed = passed, failed = failed, checks = checks, fixtureOnly = true, foregroundAndCursorRestored = cursorRestored && foregroundRestored, cursorRestored = cursorRestored, foregroundRestored = foregroundRestored }));
        return failed == 0 ? 0 : 1;
    }
    static Dictionary<string, object> Args(params object[] items) { var d = new Dictionary<string, object>(); for (int i = 0; i < items.Length; i += 2) d.Add((string)items[i], items[i + 1]); return d; }
    static Dictionary<string, object> Wire(string method, Dictionary<string, object> args)
    {
        var request = Args("id", "fixture-test", "method", method, "args", args ?? new Dictionary<string, object>(), "installRoot", "fixture-only");
        var decoded = (Dictionary<string, object>)Json.DeserializeObject(Json.Serialize(request));
        return (Dictionary<string, object>)Json.DeserializeObject(Json.Serialize(Dispatch(decoded)));
    }
    static void Fresh() { Wire("observe", Args("windowId", FixtureWindow.ToInt64())); }
    static void Do(string action, Dictionary<string, object> parameters) { if ((action == "click" && !parameters.ContainsKey("element_index") || action == "drag" || action == "move" || action == "scroll") && !parameters.ContainsKey("screenshotId")) parameters["screenshotId"] = "screenshot-0"; Wire("action", Args("windowId", FixtureWindow.ToInt64(), "action", action, "parameters", parameters)); }
    static int FindIndex(string name) { foreach (var pair in Elements) if (SafeName(pair.Value) == name) return pair.Key; throw new Exception("Fixture element not found: " + name); }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public HARDWAREINPUT hardware; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
    [StructLayout(LayoutKind.Sequential)] struct MENUINFO { public uint cbSize, fMask, dwStyle, cyMax; public IntPtr hbrBack; public uint dwContextHelpID; public UIntPtr dwMenuData; }
    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr window);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu, int position);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int count, uint flags);
    [DllImport("user32.dll")] static extern bool GetMenuInfo(IntPtr menu, ref MENUINFO info);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr command, string label);
    [DllImport("user32.dll")] static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr owner, IntPtr parameters);
    [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rectangle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder title, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread, uint attachTo, bool attach);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr device, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
}
