// Windows audio ENDPOINT control (§5 capture recovery).
//
// WHY THIS EXISTS: Chromium/Electron can only capture loopback from the Windows DEFAULT render
// endpoint. `setDisplayMediaRequestHandler` accepts 'loopback' | 'loopbackWithMute' | WebFrameMain
// and nothing else (electron.d.ts) — there is NO API to loopback a NAMED device. So when Windows
// picks the wrong default, re-acquiring getDisplayMedia returns the same silent endpoint forever;
// measured live 2026-09-22, six recovery attempts over 18 minutes all re-bound to a monitor nobody
// played to while the meeting came out of the laptop speakers.
//
// Two primitives Electron fundamentally cannot provide:
//   list  — per-endpoint PEAK LEVEL via IAudioMeterInformation, which reads the meter WITHOUT
//           opening a capture stream. This answers "which device actually has sound right now?"
//           for every endpoint at once; the renderer can only ever measure the one it is bound to.
//   set   — set the default render endpoint via IPolicyConfig, so a later getDisplayMedia binds
//           somewhere useful.
//
// Invoked as `YourCallAgent.exe --audio list` / `--audio set <id>`. Prints ONE JSON line and
// exits; it must never enter the UIA poll loop (see Program.Main).
//
// IPolicyConfig is UNDOCUMENTED. It is the mechanism every tool in this space uses (nircmd,
// SoundVolumeView, AudioDeviceCmdlets) and has been stable since Windows 7, but it is not
// contractual and a future Windows build may drop it. Every failure path here therefore prints
// {"ok":false,...} and returns a non-zero exit code rather than throwing: the JS side degrades to
// notify-only, which is exactly today's behaviour.

using System.Runtime.InteropServices;
using System.Text;

internal static class AudioEndpoints
{
    // --- Core Audio COM -----------------------------------------------------------------------
    private const int DEVICE_STATE_ACTIVE = 0x00000001;
    private const uint STGM_READ = 0;
    // eRender = 0 (output). eConsole = 0 / eMultimedia = 1 / eCommunications = 2 — the three
    // independent "default" roles Windows keeps. We set ALL of them: Chromium's loopback follows
    // eConsole, but leaving eMultimedia/eCommunications pointed elsewhere is what produces the
    // split-brain state this whole feature exists to fix.
    private const int ERender = 0;

    private static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid CLSID_PolicyConfigClient = new("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");
    // PKEY_Device_FriendlyName — the human label ("Speakers (Realtek(R) Audio)").
    private static readonly Guid PKEY_Device_FriendlyName_Fmtid = new("A45C254E-DF1C-4EFD-8020-67D146A850E0");
    private const int PKEY_Device_FriendlyName_Pid = 14;

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
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
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(uint access, out IPropertyStore properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        int GetCount(out int count);
        int GetAt(int index, out PropertyKey key);
        int GetValue(ref PropertyKey key, out PropVariant value);
        int SetValue(ref PropertyKey key, ref PropVariant value);
        int Commit();
    }

    // The meter. Reading this does NOT open a capture stream, which is the entire point: we can
    // poll every endpoint cheaply while the recorder holds exactly one of them.
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
    }

    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr format);
        int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, bool def, out IntPtr format);
        int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpoint, IntPtr mix);
        int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, bool def, out long a, out long b);
        int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr period);
        int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr mode);
        int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, bool store, ref PropertyKey key, out PropVariant value);
        int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, bool store, ref PropertyKey key, ref PropVariant value);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, bool visible);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid Fmtid; public int Pid; }

    // Only the string case is read, but the struct must match the full native union size or the
    // marshaller corrupts the stack on GetValue.
    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public short Vt;
        [FieldOffset(8)] public IntPtr PointerValue;
        [FieldOffset(8)] public long LongValue;
    }

    private sealed record Endpoint(string Id, string Name, bool IsDefault, float Peak);

    // --- Public entry -------------------------------------------------------------------------
    // Returns a process exit code. Never throws: a hard failure still prints valid JSON so the JS
    // side can distinguish "no such capability" from "spawn broke".
    public static int Run(string[] args)
    {
        var sub = args.SkipWhile(a => a != "--audio").Skip(1).FirstOrDefault() ?? "list";
        try
        {
            if (sub == "list") return List();
            if (sub == "set")
            {
                var id = args.SkipWhile(a => a != "--audio").Skip(2).FirstOrDefault();
                if (string.IsNullOrWhiteSpace(id)) return Fail("set requires a device id");
                return SetDefault(id!);
            }
            return Fail($"unknown subcommand: {sub}");
        }
        catch (Exception ex)
        {
            return Fail($"{ex.GetType().Name}: {ex.Message}");
        }
    }

    // `samples`/`intervalMs`: the meter is instantaneous, so a single read lands in a gap between
    // words and reports 0 on a perfectly live endpoint. Sampling across ~1s and keeping the MAX is
    // what makes "has audio" stable. Same max-over-window reasoning as the renderer's warm-up check.
    private static int List()
    {
        const int samples = 10;
        const int intervalMs = 100;

        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(
            Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator)!)!;

        string defaultId = "";
        // No default at all is legal (every endpoint disabled) — not an error.
        if (enumerator.GetDefaultAudioEndpoint(ERender, 0, out var defDev) == 0 && defDev != null)
        {
            defDev.GetId(out defaultId);
        }

        enumerator.EnumAudioEndpoints(ERender, DEVICE_STATE_ACTIVE, out var collection);
        collection.GetCount(out var count);

        var ids = new List<string>();
        var names = new List<string>();
        var meters = new List<IAudioMeterInformation?>();

        for (var i = 0; i < count; i++)
        {
            collection.Item(i, out var dev);
            dev.GetId(out var id);
            ids.Add(id);
            names.Add(FriendlyName(dev) ?? id);
            meters.Add(Meter(dev));
        }

        var peaks = new float[count];
        for (var s = 0; s < samples; s++)
        {
            for (var i = 0; i < count; i++)
            {
                var m = meters[i];
                if (m == null) continue;
                if (m.GetPeakValue(out var p) == 0 && p > peaks[i]) peaks[i] = p;
            }
            if (s < samples - 1) Thread.Sleep(intervalMs);
        }

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"endpoints\":[");
        for (var i = 0; i < count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"id\":").Append(JsonString(ids[i]))
              .Append(",\"name\":").Append(JsonString(names[i]))
              .Append(",\"isDefault\":").Append(ids[i] == defaultId ? "true" : "false")
              .Append(",\"peak\":").Append(peaks[i].ToString("0.000000", System.Globalization.CultureInfo.InvariantCulture))
              .Append('}');
        }
        sb.Append("]}");
        Console.WriteLine(sb.ToString());
        return 0;
    }

    // Sets all three roles. eConsole is what loopback follows; the other two are set so the system
    // does not end up in a split state where media and calls route to different devices.
    private static int SetDefault(string id)
    {
        object raw;
        try
        {
            raw = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_PolicyConfigClient)!)!;
        }
        catch (Exception ex)
        {
            // The documented-to-be-undocumented failure. Report it as a capability gap, not a crash.
            return Fail($"IPolicyConfig unavailable: {ex.Message}", "no-policy-config");
        }

        if (raw is not IPolicyConfig policy) return Fail("IPolicyConfig QI failed", "no-policy-config");

        for (var role = 0; role <= 2; role++)
        {
            var hr = policy.SetDefaultEndpoint(id, role);
            if (hr != 0) return Fail($"SetDefaultEndpoint(role={role}) failed: 0x{hr:X8}");
        }

        Console.WriteLine("{\"ok\":true,\"set\":" + JsonString(id) + "}");
        return 0;
    }

    private static IAudioMeterInformation? Meter(IMMDevice dev)
    {
        var iid = typeof(IAudioMeterInformation).GUID;
        try
        {
            // CLSCTX_ALL = 23. A device can refuse activation (exclusive-mode hold, driver bug);
            // that endpoint simply reports no peak rather than failing the whole listing.
            if (dev.Activate(ref iid, 23, IntPtr.Zero, out var o) == 0) return o as IAudioMeterInformation;
        }
        catch { /* endpoint not meterable — treat as silent */ }
        return null;
    }

    private static string? FriendlyName(IMMDevice dev)
    {
        try
        {
            if (dev.OpenPropertyStore(STGM_READ, out var store) != 0) return null;
            var key = new PropertyKey { Fmtid = PKEY_Device_FriendlyName_Fmtid, Pid = PKEY_Device_FriendlyName_Pid };
            if (store.GetValue(ref key, out var v) != 0) return null;
            return v.Vt == 31 /* VT_LPWSTR */ ? Marshal.PtrToStringUni(v.PointerValue) : null;
        }
        catch { return null; }
    }

    private static int Fail(string message, string code = "error")
    {
        Console.WriteLine("{\"ok\":false,\"code\":" + JsonString(code) + ",\"error\":" + JsonString(message) + "}");
        return 1;
    }

    private static string JsonString(string? s)
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
