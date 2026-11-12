// Meeting-detection signal source (§8) — `YourCallAgent.exe --watch`.
//
// WHY THIS EXISTS: detection used to guess from window titles. The shipped app had no
// get-windows module at all, so it fell back to a PowerShell `Get-Process … MainWindowTitle` poll
// (~1.2 s per call) that sees ONE title per process — the active Chrome tab, Teams' main window
// rather than its meeting window — and modern Teams meeting windows carry no "Meeting"/"Call" in
// their title anyway. Most Teams meetings were therefore only ever detected through the registry
// mic flag, and anything else (Slack huddles, RingCentral, Firefox) not at all.
//
// The question that actually defines "in a call" is: which process is holding the microphone
// right now? Windows answers that per process through the audio session API. This mode polls it
// every 2 s, together with which processes are PLAYING audio and every visible window title, and
// prints one JSON line per poll:
//
//   {"type":"calls","ts":…,"mic":[{"pid":1,"proc":"ms-teams"}],
//    "playing":[{"pid":2,"proc":"chrome"}],"windows":[{"pid":3,"proc":"chrome","title":"Meet - …"}]}
//
// All interpretation (which app, is it a meeting, when did it end) lives in src/detector.js, where
// it is unit-tested. This file only reports facts. Ends on EOF/"stop" on stdin.

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class CallWatch
{
    private const int CLSCTX_ALL = 23;
    private const int DEVICE_STATE_ACTIVE = 0x1;
    private const int ERender = 0, ECapture = 1;
    private const int AudioSessionStateActive = 1;
    private static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IID_IAudioSessionManager2 = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl2 session);
    }

    // IAudioSessionControl2 declared with the base interface's methods first, in vtable order.
    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(IntPtr name, IntPtr ctx);
        int GetIconPath(out IntPtr path);
        int SetIconPath(IntPtr path, IntPtr ctx);
        int GetGroupingParam(out Guid param);
        int SetGroupingParam(ref Guid param, IntPtr ctx);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    private static volatile bool _stop;

    public static int Run(string[] args)
    {
        new Thread(() =>
        {
            try { string? l; while ((l = Console.ReadLine()) != null) if (l.Trim() == "stop") break; }
            catch { }
            _stop = true;
        }) { IsBackground = true }.Start();

        var once = args.Contains("--once");
        var procNames = new Dictionary<uint, string>();
        while (!_stop)
        {
            try
            {
                var mic = ActiveSessions(ECapture);
                var playing = ActiveSessions(ERender);
                var windows = VisibleWindows();
                var sb = new StringBuilder("{\"type\":\"calls\",\"ts\":");
                sb.Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                sb.Append(",\"mic\":"); AppendProcs(sb, mic, procNames);
                sb.Append(",\"playing\":"); AppendProcs(sb, playing, procNames);
                sb.Append(",\"windows\":[");
                var first = true;
                foreach (var (pid, title) in windows)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"pid\":").Append(pid).Append(",\"proc\":").Append(Json(ProcName(pid, procNames)))
                      .Append(",\"title\":").Append(Json(title)).Append('}');
                }
                sb.Append("]}");
                Console.Out.WriteLine(sb.ToString());
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                Console.Out.WriteLine("{\"type\":\"calls-error\",\"error\":" + Json(ex.Message) + "}");
                Console.Out.Flush();
            }
            if (once) break;
            // Process names are cached per pid; pids are reused, so drop the cache now and then.
            if (procNames.Count > 2000) procNames.Clear();
            for (var i = 0; i < 20 && !_stop; i++) Thread.Sleep(100);
        }
        return 0;
    }

    // Distinct pids with an ACTIVE session (a stream that is running, not merely open) on any
    // endpoint of the given direction. System sounds and our own process are excluded.
    private static HashSet<uint> ActiveSessions(int flow)
    {
        var pids = new HashSet<uint>();
        var self = (uint)Environment.ProcessId;
        var en = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator)!)!;
        if (en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out var col) != 0) return pids;
        col.GetCount(out var count);
        for (var i = 0; i < count; i++)
        {
            try
            {
                if (col.Item(i, out var dev) != 0) continue;
                var iid = IID_IAudioSessionManager2;
                if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out var o) != 0) continue;
                var mgr = (IAudioSessionManager2)o;
                if (mgr.GetSessionEnumerator(out var sessions) != 0) continue;
                sessions.GetCount(out var n);
                for (var s = 0; s < n; s++)
                {
                    try
                    {
                        if (sessions.GetSession(s, out var ctl) != 0) continue;
                        if (ctl.IsSystemSoundsSession() == 0) continue; // S_OK means "is system sounds"
                        ctl.GetState(out var state);
                        if (state != AudioSessionStateActive) continue;
                        ctl.GetProcessId(out var pid);
                        if (pid != 0 && pid != self) pids.Add(pid);
                    }
                    catch { /* session went away mid-read */ }
                }
            }
            catch { /* endpoint refused activation */ }
        }
        return pids;
    }

    private static List<(uint Pid, string Title)> VisibleWindows()
    {
        var list = new List<(uint, string)>();
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h)) return true;
            var len = GetWindowTextLength(h);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            GetWindowThreadProcessId(h, out var pid);
            list.Add((pid, sb.ToString()));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    private static void AppendProcs(StringBuilder sb, HashSet<uint> pids, Dictionary<uint, string> names)
    {
        sb.Append('[');
        var first = true;
        foreach (var pid in pids)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"pid\":").Append(pid).Append(",\"proc\":").Append(Json(ProcName(pid, names))).Append('}');
        }
        sb.Append(']');
    }

    private static string ProcName(uint pid, Dictionary<uint, string> cache)
    {
        if (cache.TryGetValue(pid, out var n)) return n;
        try { n = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); }
        catch { n = ""; }
        cache[pid] = n;
        return n;
    }

    private static string Json(string? s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
