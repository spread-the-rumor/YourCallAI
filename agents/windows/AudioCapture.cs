// Native system-audio capture (§5) — `YourCallAgent.exe --capture <recordingDir>`.
//
// WHY THIS EXISTS: Chromium's loopback can only capture the Windows DEFAULT render endpoint
// (Electron 37: 'loopback' | 'loopbackWithMute' | WebFrameMain, nothing else). Everything that
// changes or bypasses the default — connecting a display, a Bluetooth headset arriving, Teams or
// Zoom configured to a specific speaker rather than "Default" — leaves that capture listening to
// an endpoint nobody plays to. Re-acquiring cannot help; it returns the default again.
//
// This mode does not depend on the default at all. It opens WASAPI loopback on EVERY active render
// endpoint, re-enumerates every couple of seconds so new devices are picked up and removed ones are
// dropped, and mixes them onto ONE wall-clock timeline:
//
//   <dir>/system.pcm   signed 16-bit little-endian, 16 kHz, mono
//   <dir>/system.json  { startedAtMs, sampleRate, channels, format }
//
// Sample i of system.pcm is wall time startedAtMs + i/16000 s, whatever happened in between: an
// endpoint that delivers nothing (WASAPI loopback is SILENT-BY-ABSENCE when no stream plays) is
// zero-filled, so a device swap is a gap in sound, never a gap in time. The app aligns this file
// against the recorder's own audio at transcription time and uses it for the meeting channel.
//
// Stops on "stop" or EOF on stdin (so a crashed parent never leaves it running). Status lines go to
// stdout as JSON for capture.jsonl.

using System.Diagnostics;
using System.IO; // WPF projects drop System.IO from the implicit usings
using System.Runtime.InteropServices;
using System.Text;

internal static class AudioCapture
{
    private const int SampleRate = 16000;
    // The mixer emits audio this far behind real time, so packets that arrive a little late (WASAPI
    // delivers in ~10 ms bursts, threads get descheduled) still land in their own slot.
    private const int MixLatencyMs = 250;
    // An endpoint whose backlog exceeds this is running ahead of the wall clock (device clock drift,
    // or a burst after a stall); the excess oldest samples are dropped so sync never degrades.
    private const int MaxBacklogMs = 500;

    private const int CLSCTX_ALL = 23;
    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    private const int DEVICE_STATE_ACTIVE = 0x1;
    private const int ERender = 0;

    private static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static readonly Guid SUBTYPE_FLOAT = new("00000003-0000-0010-8000-00aa00389b71");
    private static readonly Guid SUBTYPE_PCM = new("00000001-0000-0010-8000-00aa00389b71");
    private static readonly Guid PKEY_FriendlyName_Fmtid = new("A45C254E-DF1C-4EFD-8020-67D146A850E0");

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
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
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential)] private struct PropertyKey { public Guid Fmtid; public int Pid; }
    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant { [FieldOffset(0)] public short Vt; [FieldOffset(8)] public IntPtr Ptr; [FieldOffset(8)] public long L; }

    // One captured endpoint: its thread fills Queue (16 kHz mono float); the mixer drains it.
    private sealed class Source
    {
        public string Id = "";
        public string Name = "";
        public readonly Queue<float> Queue = new();
        public volatile bool Dead;
        public volatile float Peak; // max |sample| since the last status line
        public long Frames;         // device frames captured, for diagnostics
        public string? Error;
    }

    private static readonly Dictionary<string, Source> Sources = new();
    private static readonly object SourcesLock = new();
    private static volatile bool _stop;

    public static int Run(string[] args)
    {
        var dir = args.SkipWhile(a => a != "--capture").Skip(1).FirstOrDefault();
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
        {
            Emit("{\"type\":\"native-capture\",\"state\":\"error\",\"error\":\"--capture needs an existing directory\"}");
            return 2;
        }

        // Stop on "stop" or EOF. EOF is the important one: if the app dies, its pipe closes and
        // this process ends instead of recording forever.
        new Thread(() =>
        {
            try { string? l; while ((l = Console.ReadLine()) != null) if (l.Trim() == "stop") break; }
            catch { /* stdin gone */ }
            _stop = true;
        }) { IsBackground = true }.Start();

        var startedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var clock = Stopwatch.StartNew();
        File.WriteAllText(Path.Combine(dir, "system.json"),
            "{\"startedAtMs\":" + startedAtMs + ",\"sampleRate\":" + SampleRate + ",\"channels\":1,\"format\":\"s16le\"}");

        using var output = new FileStream(Path.Combine(dir, "system.pcm"), FileMode.Create, FileAccess.Write, FileShare.Read);
        Emit("{\"type\":\"native-capture\",\"state\":\"started\",\"startedAtMs\":" + startedAtMs + "}");

        long written = 0;
        long lastEnum = -10_000, lastStatus = 0, lastFlush = 0;
        var mix = new float[SampleRate];   // reused scratch, 1 s worth
        var bytes = new byte[SampleRate * 2];
        double sumSq = 0; long sumN = 0;

        while (!_stop)
        {
            var nowMs = clock.ElapsedMilliseconds;
            if (nowMs - lastEnum >= 2000) { lastEnum = nowMs; Enumerate(); }

            // Emit everything up to (now - latency) on the wall-clock timeline.
            var target = Math.Max(0, (nowMs - MixLatencyMs) * SampleRate / 1000);
            while (written < target)
            {
                var n = (int)Math.Min(target - written, mix.Length);
                Array.Clear(mix, 0, n);
                lock (SourcesLock)
                {
                    foreach (var s in Sources.Values)
                    {
                        lock (s.Queue)
                        {
                            var maxBacklog = MaxBacklogMs * SampleRate / 1000 + n;
                            while (s.Queue.Count > maxBacklog) s.Queue.Dequeue();
                            var take = Math.Min(n, s.Queue.Count);
                            for (var i = 0; i < take; i++) mix[i] += s.Queue.Dequeue();
                            // Fewer than n available = the endpoint delivered nothing for that
                            // span (silent-by-absence). Its share stays zero: time keeps moving.
                        }
                    }
                }
                for (var i = 0; i < n; i++)
                {
                    var v = Math.Clamp(mix[i], -1f, 1f);
                    sumSq += v * v; sumN++;
                    var q = (short)(v * 32767);
                    bytes[2 * i] = (byte)(q & 0xFF);
                    bytes[2 * i + 1] = (byte)((q >> 8) & 0xFF);
                }
                output.Write(bytes, 0, n * 2);
                written += n;
            }

            if (nowMs - lastFlush >= 1000) { lastFlush = nowMs; output.Flush(); }
            if (nowMs - lastStatus >= 15000)
            {
                lastStatus = nowMs;
                Emit(Status(written, sumN > 0 ? Math.Sqrt(sumSq / sumN) : 0));
                sumSq = 0; sumN = 0;
            }
            Thread.Sleep(20);
        }

        output.Flush();
        lock (SourcesLock) foreach (var s in Sources.Values) s.Dead = true;
        Emit("{\"type\":\"native-capture\",\"state\":\"stopped\",\"samples\":" + written + "}");
        return 0;
    }

    private static string Status(long written, double rms)
    {
        var sb = new StringBuilder("{\"type\":\"native-capture\",\"state\":\"running\",\"samples\":");
        sb.Append(written).Append(",\"rms\":").Append(rms.ToString("0.000000", System.Globalization.CultureInfo.InvariantCulture));
        sb.Append(",\"endpoints\":[");
        lock (SourcesLock)
        {
            var first = true;
            foreach (var s in Sources.Values)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":").Append(Json(s.Name))
                  .Append(",\"dead\":").Append(s.Dead ? "true" : "false")
                  .Append(",\"peak\":").Append(s.Peak.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture))
                  .Append(",\"frames\":").Append(s.Frames);
                if (s.Error != null) sb.Append(",\"error\":").Append(Json(s.Error));
                sb.Append('}');
                s.Peak = 0;
            }
        }
        return sb.Append("]}").ToString();
    }

    // Start a capture thread for every active render endpoint not already captured, and forget
    // endpoints whose thread has died (unplugged, disabled, driver reset) so they can come back.
    private static void Enumerate()
    {
        try
        {
            var en = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator)!)!;
            if (en.EnumAudioEndpoints(ERender, DEVICE_STATE_ACTIVE, out var col) != 0) return;
            col.GetCount(out var count);
            var seen = new HashSet<string>();
            for (var i = 0; i < count; i++)
            {
                if (col.Item(i, out var dev) != 0) continue;
                dev.GetId(out var id);
                seen.Add(id);
                lock (SourcesLock)
                {
                    if (Sources.TryGetValue(id, out var existing) && !existing.Dead) continue;
                    if (existing != null) Sources.Remove(id);
                    var src = new Source { Id = id, Name = FriendlyName(dev) ?? id };
                    Sources[id] = src;
                    var t = new Thread(() => CaptureLoop(src)) { IsBackground = true, Name = "loopback " + src.Name };
                    t.Start();
                    Emit("{\"type\":\"native-capture\",\"state\":\"endpoint-added\",\"name\":" + Json(src.Name) + "}");
                }
            }
            lock (SourcesLock)
            {
                foreach (var gone in Sources.Values.Where(s => !seen.Contains(s.Id)).ToList())
                {
                    gone.Dead = true;
                    Sources.Remove(gone.Id);
                    Emit("{\"type\":\"native-capture\",\"state\":\"endpoint-removed\",\"name\":" + Json(gone.Name) + "}");
                }
            }
        }
        catch (Exception ex)
        {
            Emit("{\"type\":\"native-capture\",\"state\":\"enumerate-failed\",\"error\":" + Json(ex.Message) + "}");
        }
    }

    // Runs on its own (MTA) thread: the device is re-acquired here so every COM object this loop
    // touches lives in the apartment that uses it.
    private static void CaptureLoop(Source src)
    {
        IntPtr fmtPtr = IntPtr.Zero;
        IAudioClient? client = null;
        try
        {
            var en = (IMMDeviceEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator)!)!;
            if (en.GetDevice(src.Id, out var dev) != 0) throw new Exception("GetDevice failed");
            var iid = IID_IAudioClient;
            Check(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out var o), "Activate");
            client = (IAudioClient)o;
            Check(client.GetMixFormat(out fmtPtr), "GetMixFormat");
            var fmt = ReadFormat(fmtPtr);
            // 1 s shared buffer: polled every 10 ms, so overflow would need a 1 s stall.
            Check(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10_000_000, 0, fmtPtr, IntPtr.Zero), "Initialize");
            var ciid = IID_IAudioCaptureClient;
            Check(client.GetService(ref ciid, out var svc), "GetService");
            var cap = (IAudioCaptureClient)svc;
            Check(client.Start(), "Start");

            var step = (double)fmt.Rate / SampleRate; // device frames per output sample
            double pos = 0;                            // fractional read position into the stream
            float prev = 0;                            // last device frame (mono) for interpolation
            var scratch = new List<float>(4096);

            while (!src.Dead && !_stop)
            {
                Thread.Sleep(10);
                while (true)
                {
                    var hr = cap.GetNextPacketSize(out var packet);
                    if (hr != 0) throw new COMException("GetNextPacketSize", hr);
                    if (packet == 0) break;
                    Check(cap.GetBuffer(out var data, out var frames, out var flags, out _, out _), "GetBuffer");
                    scratch.Clear();
                    var silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                    for (var f = 0; f < frames; f++)
                    {
                        var cur = silent ? 0f : MonoFrame(data, f, fmt);
                        // Linear resample to 16 kHz: emit every output sample whose position falls
                        // between the previous and the current device frame.
                        while (pos <= 1.0)
                        {
                            scratch.Add(prev + (cur - prev) * (float)pos);
                            pos += step;
                        }
                        pos -= 1.0;
                        prev = cur;
                    }
                    cap.ReleaseBuffer(frames);
                    src.Frames += frames;
                    float peak = src.Peak;
                    foreach (var v in scratch) { var a = Math.Abs(v); if (a > peak) peak = a; }
                    src.Peak = peak;
                    lock (src.Queue) foreach (var v in scratch) src.Queue.Enqueue(v);
                }
            }
            client.Stop();
        }
        catch (Exception ex)
        {
            // AUDCLNT_E_DEVICE_INVALIDATED (0x88890004) is the normal way an unplugged device ends.
            src.Error = ex is COMException ce ? $"{ex.Message} 0x{ce.HResult:X8}" : ex.Message;
            Emit("{\"type\":\"native-capture\",\"state\":\"endpoint-failed\",\"name\":" + Json(src.Name) + ",\"error\":" + Json(src.Error) + "}");
        }
        finally
        {
            src.Dead = true;
            if (fmtPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(fmtPtr);
        }
    }

    private readonly record struct Fmt(int Rate, int Channels, int Bits, bool Float, int BlockAlign);

    private static Fmt ReadFormat(IntPtr p)
    {
        var tag = (ushort)Marshal.ReadInt16(p, 0);
        var ch = Marshal.ReadInt16(p, 2);
        var rate = Marshal.ReadInt32(p, 4);
        var block = Marshal.ReadInt16(p, 12);
        var bits = Marshal.ReadInt16(p, 14);
        var isFloat = tag == 3;
        if (tag == 0xFFFE)
        {
            var sub = Marshal.PtrToStructure<Guid>(p + 24);
            if (sub == SUBTYPE_FLOAT) isFloat = true;
            else if (sub != SUBTYPE_PCM) throw new NotSupportedException("unsupported mix subformat " + sub);
        }
        else if (tag != 1 && tag != 3) throw new NotSupportedException("unsupported mix format tag " + tag);
        return new Fmt(rate, ch, bits, isFloat, block);
    }

    // Average every channel of one frame into a mono float in [-1, 1].
    private static float MonoFrame(IntPtr data, int frame, Fmt fmt)
    {
        var basePtr = data + frame * fmt.BlockAlign;
        var bytesPer = fmt.Bits / 8;
        float sum = 0;
        for (var c = 0; c < fmt.Channels; c++)
        {
            var p = basePtr + c * bytesPer;
            float v;
            if (fmt.Float) v = BitConverter.Int32BitsToSingle(Marshal.ReadInt32(p));
            else if (fmt.Bits == 16) v = Marshal.ReadInt16(p) / 32768f;
            else if (fmt.Bits == 24) v = ((Marshal.ReadByte(p) | (Marshal.ReadByte(p + 1) << 8) | (Marshal.ReadByte(p + 2) << 16)) << 8 >> 8) / 8388608f;
            else v = Marshal.ReadInt32(p) / 2147483648f;
            sum += v;
        }
        return sum / fmt.Channels;
    }

    private static void Check(int hr, string what)
    {
        if (hr != 0) throw new COMException(what, hr);
    }

    private static string? FriendlyName(IMMDevice dev)
    {
        try
        {
            if (dev.OpenPropertyStore(0, out var store) != 0) return null;
            var key = new PropertyKey { Fmtid = PKEY_FriendlyName_Fmtid, Pid = 14 };
            if (store.GetValue(ref key, out var v) != 0) return null;
            return v.Vt == 31 ? Marshal.PtrToStringUni(v.Ptr) : null;
        }
        catch { return null; }
    }

    private static readonly object EmitLock = new();
    private static void Emit(string line)
    {
        lock (EmitLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
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
