// Your Call AI — Windows active-speaker agent (§7 Layer 1).
// Reads meeting UIs via UI Automation and emits one JSON line per observation to stdout:
//   {"ts":1720512003120,"type":"active-speaker","name":"Priya Shah","confidence":0.75,"strategy":"suffix-delta"}
//   {"ts":1720512000000,"type":"roster","names":["Priya Shah","Sam Ortiz"],"source":"participants-panel","confidence":0.9}
// UIA clients connecting is what makes Chromium build its a11y tree — no extra flags needed.
//
// DESIGN: match on STRUCTURE, never on English UI strings.
// The previous version keyed off literal phrases ("<Name> is speaking", "Speaking: <name>") and
// window titles. Both break constantly: the phrases are localized and get reworded on every UI
// ship, and title gating meant browser-hosted Teams/Zoom were never handled at all while modern
// Teams titles (no "Meeting"/"Call") never matched. Instead:
//   - Find the participants panel by shape: a List/DataGrid of ListItems that mostly look like
//     people's names. Meet, Zoom and Teams all render it that way, in every language.
//   - Find the active speaker by DECORATION DELTA: we already know the clean roster names, so a
//     node whose text is "<a known name> + extra" is that person with a status appended. This
//     compares against a name WE extracted, so it is immune to both localization and rewording.
// Selector heuristics live in Heuristics/NameHeuristics; bump HeuristicsVersion when they change.
//
// Run with --dump to print the raw a11y tree of every candidate window and exit — the instrument
// for diagnosing a platform whose names stop resolving.
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Automation;

internal static class Agent
{
    private const string HeuristicsVersion = "2026-09-deep-walk";
    // CollectNodes is a BREADTH-first walk with a hard node cap. Teams participant rows sit at
    // depth ~14 (see MinWebContentDepth), and a Chromium/WebView2 tree is very wide, so a 400-node
    // budget was exhausted on shallow levels and NEVER reached the roster — three consecutive
    // meetings emitted zero roster events while --dump (which used 1200) appeared to work.
    // Deep enough to reach web content, and the poll is slowed to pay for the extra UIA calls;
    // the roster changes on the order of seconds, so 2x/s bought nothing.
    private const int NodeBudget = 3000;
    private const int PollIntervalMs = 2500;
    private static string? _lastSpeaker;
    private static string _lastRosterKey = "";
    // Roster names carried between polls: the decoration-delta strategy needs the clean names
    // before it can spot a decorated one, and the panel may be closed by the time someone speaks.
    private static readonly HashSet<string> KnownNames = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, string> LastDecorations = new(StringComparer.OrdinalIgnoreCase);

    // [STAThread] is REQUIRED. System.Windows.Automation's static initializer (CacheRequest) throws
    // TypeInitializationException on an MTA thread, which .NET uses by default for a console app.
    // Every call into UIA then fails, so the agent enumerated ZERO windows and silently emitted no
    // roster for entire meetings — the failure looked like a bad heuristic but nothing was ever read.
    [STAThread]
    private static void Main(string[] args)
    {
        // --audio must be routed FIRST and must Environment.Exit: it is a one-shot query/command
        // that prints a single JSON line, and it must never fall through into the UIA poll loop
        // below (which never returns). It also does no UIA work at all, so it is unaffected by
        // the [STAThread]/CacheRequest constraint that governs the rest of this file.
        if (args.Contains("--audio")) { Environment.Exit(AudioEndpoints.Run(args)); return; }
        // --capture and --watch are long-running but likewise do no UIA work, and must never fall
        // into the poll loop. Each is its own process so a fault in one cannot take another down.
        if (args.Contains("--capture")) { Environment.Exit(AudioCapture.Run(args)); return; }
        if (args.Contains("--watch")) { Environment.Exit(CallWatch.Run(args)); return; }
        if (args.Contains("--dump")) { Dump(); return; }
        if (args.Contains("--windows")) { DumpWindows(); return; }
        Console.Error.WriteLine($"[agent] started, heuristics={HeuristicsVersion}");
        while (true)
        {
            try { Poll(); }
            catch (Exception ex) { Console.Error.WriteLine($"[agent] poll error: {ex.Message}"); }
            Thread.Sleep(PollIntervalMs);
        }
    }

    // Windows that could host a meeting, classified by owning PROCESS rather than title.
    private static IEnumerable<(AutomationElement Window, string Family, string Title)> MeetingWindows()
    {
        AutomationElementCollection windows;
        try { windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition); }
        catch (Exception ex)
        {
            // Never silently swallow this: if the root enumeration fails the agent is completely
            // blind, and every downstream heuristic is irrelevant.
            TopLevelWindows = -1;
            Console.Error.WriteLine($"[agent] window enumeration failed: {ex.GetType().Name}: {ex.Message}");
            for (var inner = ex.InnerException; inner != null; inner = inner.InnerException)
                Console.Error.WriteLine($"[agent]   caused by: {inner.GetType().FullName}: {inner.Message}");
            yield break;
        }
        TopLevelWindows = windows.Count;
        ProcNameFailures = 0;

        foreach (AutomationElement w in windows)
        {
            string title, proc = "";
            try { title = w.Current.Name ?? ""; } catch { continue; }
            try { proc = Process.GetProcessById(w.Current.ProcessId).ProcessName.ToLowerInvariant(); }
            catch { ProcNameFailures++; /* exited or access denied — fall back to the title below */ }

            string family =
                Regex.IsMatch(proc, @"chrome|msedge|edge|chromium|brave|opera|vivaldi") ? "browser"
                : Regex.IsMatch(proc, @"zoom|cpthost") ? "zoom"
                : Regex.IsMatch(proc, @"teams") ? "teams"
                : Regex.IsMatch(proc, @"slack") ? "slack"
                // No process name (denied): keep the old title signal as a last resort.
                : Regex.IsMatch(title, @"Zoom Meeting", RegexOptions.IgnoreCase) ? "zoom"
                : Regex.IsMatch(title, @"Microsoft Teams", RegexOptions.IgnoreCase) ? "teams"
                : "";

            if (family.Length > 0) yield return (w, family, title);
        }
    }

    private static void Poll()
    {
        var roster = new List<string>();
        string? rosterSource = null;
        int expectedCount = 0;
        Candidate? best = null;
        int windowsSeen = 0, inCallSeen = 0, maxNodes = 0, deepest = 0;

        // No early return: a Meet tab AND the Teams app can both be open, and the old code stopped
        // at the first match, silently losing whichever came second.
        foreach (var (window, family, _) in MeetingWindows())
        {
            List<Node> nodes;
            try { nodes = UiaHelpers.CollectNodes(window, NodeBudget); }
            catch { continue; }
            if (nodes.Count == 0) continue;

            windowsSeen++;
            var obs = Heuristics.Observe(nodes, family, KnownNames, LastDecorations);
            if (obs.InCall) inCallSeen++;
            if (obs.NodeCount > maxNodes) maxNodes = obs.NodeCount;
            if (obs.MaxDepth > deepest) deepest = obs.MaxDepth;
            // A real participants panel outranks a tile-grid guess regardless of size, so an
            // ordinary browser window's incidental "list of capitalised words" cannot displace the
            // meeting's actual roster (and then poison KnownNames for the rest of the call).
            bool better = rosterSource != "participants-panel" || obs.RosterSource == "participants-panel";
            if (obs.Roster.Count > 0 && obs.Roster.Count >= roster.Count && better)
            {
                roster = obs.Roster;
                rosterSource = obs.RosterSource;
                expectedCount = obs.ExpectedCount;
            }
            if (obs.Active is not null && (best is null || obs.Active.Confidence > best.Confidence))
                best = obs.Active;
        }

        foreach (var n in roster) KnownNames.Add(n);
        Emit(best, roster, rosterSource, expectedCount);
        EmitDiagnostics(windowsSeen, inCallSeen, maxNodes, deepest, roster.Count, rosterSource);
    }

    private static void Emit(Candidate? active, List<string> roster, string? rosterSource, int expectedCount)
    {
        long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (active is not null && active.Name != _lastSpeaker)
        {
            _lastSpeaker = active.Name;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ts, type = "active-speaker", name = active.Name,
                confidence = active.Confidence, strategy = active.Strategy,
            }));
            Console.Out.Flush();
        }
        if (roster.Count > 0)
        {
            var key = string.Join("|", roster.OrderBy(x => x));
            if (key != _lastRosterKey)
            {
                _lastRosterKey = key;
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    ts, type = "roster", names = roster,
                    source = rosterSource ?? "unknown",
                    confidence = rosterSource == "participants-panel" ? 0.9 : 0.75,
                    expectedCount,
                }));
                Console.Out.Flush();
            }
        }
    }

    // Heartbeat so "found nobody" is distinguishable from "never looked". Three meetings in a row
    // emitted zero rosters with no way to tell whether the agent was blind, gated out, or starved of
    // nodes. Emitted only when the picture changes, so the log stays small.
    internal static int TopLevelWindows;
    internal static int ProcNameFailures;
    private static string _lastDiag = "";
    private static void EmitDiagnostics(int windows, int inCall, int nodes, int depth, int rosterSize, string? source)
    {
        // Bucket the node count so normal jitter does not spam a line every poll.
        var key = $"{windows}|{inCall}|{nodes / 250}|{depth / 5}|{rosterSize}|{source}|{TopLevelWindows}|{ProcNameFailures}";
        if (key == _lastDiag) return;
        _lastDiag = key;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            type = "agent-diag", windows, inCall, nodes, depth,
            rosterSize, source = source ?? "none",
            topLevelWindows = TopLevelWindows, procNameFailures = ProcNameFailures,
        }));
        Console.Out.Flush();
    }

    // Diagnostic: every top-level window UIA can see, with the process that owns it and how the
    // family classifier labelled it. Answers "is the meeting window even visible to us?" — which is
    // upstream of every heuristic and was the question we could not answer for three meetings.
    private static void DumpWindows()
    {
        AutomationElementCollection windows;
        try { windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition); }
        catch (Exception ex) { Console.WriteLine($"ENUMERATION FAILED: {ex.GetType().Name}: {ex.Message}"); return; }
        Console.WriteLine($"top-level windows: {windows.Count}");
        foreach (AutomationElement w in windows)
        {
            string title = "", proc = "", cls = "";
            int pid = 0;
            try { title = w.Current.Name ?? ""; } catch { }
            try { cls = w.Current.ClassName ?? ""; } catch { }
            try { pid = w.Current.ProcessId; } catch { }
            try { proc = Process.GetProcessById(pid).ProcessName.ToLowerInvariant(); } catch { proc = "<denied>"; }
            Console.WriteLine(JsonSerializer.Serialize(new { pid, proc, cls, title }));
        }
    }

    // Diagnostic: dump every candidate window's a11y tree so heuristics can be checked against a
    // real UI instead of guessed at. Not used in normal operation.
    private static void Dump()
    {
        foreach (var (window, family, title) in MeetingWindows())
        {
            Console.WriteLine(JsonSerializer.Serialize(new { type = "window", family, title }));
            List<Node> nodes;
            try { nodes = UiaHelpers.CollectNodes(window, NodeBudget); } catch { continue; }
            foreach (var n in nodes)
            {
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    type = "node", n.Name, control = n.ControlType, n.AutomationId,
                    n.ClassName, n.Depth, n.Parent, n.Offscreen,
                }));
            }
        }
    }
}

internal sealed record Node(
    string Name, string ControlType, string AutomationId, string ClassName,
    int Depth, int Index, int Parent, bool Offscreen);

internal sealed record Candidate(string Name, double Confidence, string Strategy);

internal sealed record Observation(
    Candidate? Active, List<string> Roster, string? RosterSource, int ExpectedCount,
    bool InCall = false, int NodeCount = 0, int MaxDepth = 0);

internal static class UiaHelpers
{
    // Walk the tree keeping STRUCTURE (control type, depth, parent), not just a flat name list —
    // finding "a list of people" is what makes the roster heuristic language-independent.
    public static List<Node> CollectNodes(AutomationElement root, int max = 400)
    {
        var results = new List<Node>();
        var walker = TreeWalker.ContentViewWalker;
        var queue = new Queue<(AutomationElement El, int Depth, int Parent)>();
        queue.Enqueue((root, 0, -1));
        while (queue.Count > 0 && results.Count < max)
        {
            var (el, depth, parent) = queue.Dequeue();
            string name = "", ctrl = "", autoId = "", cls = "";
            bool offscreen = false;
            try
            {
                var c = el.Current;
                name = c.Name ?? "";
                ctrl = c.ControlType?.ProgrammaticName ?? "";
                autoId = c.AutomationId ?? "";
                cls = c.ClassName ?? "";
                offscreen = c.IsOffscreen;
            }
            catch { }
            int myIndex = results.Count;
            results.Add(new Node(name, ShortType(ctrl), autoId, cls, depth, myIndex, parent, offscreen));
            if (depth > 24) continue; // Chromium trees can be very deep; bound the descent
            try
            {
                for (var child = walker.GetFirstChild(el); child != null; child = walker.GetNextSibling(child))
                    queue.Enqueue((child, depth + 1, myIndex));
            }
            catch { }
        }
        return results;
    }

    // "ControlType.ListItem" -> "ListItem"
    private static string ShortType(string programmatic)
    {
        if (string.IsNullOrEmpty(programmatic)) return "";
        int dot = programmatic.LastIndexOf('.');
        return dot >= 0 ? programmatic[(dot + 1)..] : programmatic;
    }
}

// Platform-independent name shaping. Mirrors src/roster.js — keep the two in step; the JS side is
// the safety net that re-validates whatever we emit here.
internal static class NameHeuristics
{
    private static readonly string[] RoleWords =
    {
        "host", "co-host", "cohost", "guest", "organizer", "organiser", "presenter", "attendee",
        "me", "you", "muted", "unmuted", "pinned", "presenting", "speaking", "owner", "moderator",
    };
    private static readonly Regex RoleTail =
        new(@"[,\-–—]\s*(" + string.Join("|", RoleWords) + @")\b.*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    // A comma-separated field that reads as UI status, not a person. Drawn from REAL Teams labels
    // captured live: "Carlos Brito, Has control of production tools, Context menu is available".
    // RoleTail alone only stripped single role words, so these clauses survived and every real
    // name failed the ≤5-token test. Mirrors STATUS_CLAUSE_RE in src/roster.js.
    private static readonly Regex StatusClause = new(
        @"\b(has|is|are|was|available|control|context|menu|video|camera|mic|microphone|muted|unmuted|sharing|shared|speaking|presenting|pinned|spotlight|raised|hand|reaction|status|indicator|tools|myself|content|elapsed|encryption)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    // Descriptive phrases that merely CONTAIN a name ("Content shared by Hernan Zapata").
    private static readonly Regex Descriptive = new(
        @"\b(shared|share|by|from|to|with|via|presented|pinned)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Parens = new(@"\([^()]*\)|\[[^\]]*\]", RegexOptions.Compiled);
    // Symbols/pictographs plus the joiners and variation selectors that ride along with them.
    // \p{Cs} (lone surrogates) is deliberately included: emoji above the BMP arrive as surrogate
    // pairs, and dropping both halves is what leaves a clean name behind.
    private static readonly Regex Glyphs = new(@"[\p{So}\p{Cs}︎️‍☀-➿]", RegexOptions.Compiled);
    private static readonly Regex MultiSpace = new(@"\s+", RegexOptions.Compiled);

    private static readonly HashSet<string> UiWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "turn", "mute", "unmute", "join", "leave", "share", "sharing", "stop", "start", "camera",
        "video", "audio", "more", "options", "raise", "hand", "chat", "people", "participants",
        "reactions", "settings", "close", "open", "search", "invite", "add", "copy", "record",
        "recording", "transcript", "captions", "present", "screen", "window", "meeting", "call",
        "everyone", "waiting", "room", "breakout", "pin", "spotlight", "remove", "admit",
    };
    private static readonly HashSet<string> Particles = new(StringComparer.OrdinalIgnoreCase)
    { "van", "von", "de", "del", "della", "da", "di", "du", "la", "le", "bin", "ibn", "al", "el", "ter", "ten", "op" };

    // Exact labels that are never a person but score like a short name, so PersonScore cannot
    // reject them. "System" is the Win32 window menu, which live Teams exposes as a MenuItem
    // SIBLING of its real participant rows. "Workspaces" is browser chrome that was actually
    // reported as an active speaker during a live call. Whole-string match only, so a person
    // named e.g. "Nav" is unaffected. Mirrors NON_PERSON_EXACT in src/roster.js.
    private static readonly HashSet<string> NonPersonExact = new(StringComparer.OrdinalIgnoreCase)
    {
        "system", "workspaces", "workspace", "profile", "default", "guest", "admin",
        "administrator", "untitled", "new tab", "home", "general", "unknown", "me", "you",
        "everyone", "notifications", "menu", "toolbar", "main", "body", "null",
        // Slack's huddle window: its message-formatting toolbar and tab labels were emitted as
        // participants and as active speakers ("Code", "Huddles") in five real huddles.
        "code", "bold", "italic", "strikethrough", "link", "quote", "code block", "huddle", "huddles",
        "activity", "later", "directories", "canvases", "lists", "dms", "threads", "files",
    };
    // Slack names its participant rows "View <name>'s profile".
    private static readonly Regex ProfileRow = new(@"^\s*View\s+(?<n>.+?)['’]s\s+profile\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static string Clean(string raw)
    {
        var s = raw ?? "";
        var prof = ProfileRow.Match(s);
        if (prof.Success) s = prof.Groups["n"].Value;
        s = Glyphs.Replace(s, " ");
        s = Parens.Replace(s, " ");
        s = RoleTail.Replace(s, "");

        // Keep the first comma-separated field that looks like a name; the rest is status. Teams
        // prefixes its own tile ("Myself video, Sagar, …"), so a leading status field is skipped
        // rather than mistaken for the name.
        if (s.Contains(','))
        {
            var fields = s.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (fields.Length > 0)
            {
                var named = Array.Find(fields, f => !StatusClause.IsMatch(f));
                s = named ?? fields[0];
            }
        }

        s = MultiSpace.Replace(s, " ").Trim();
        return s.Trim(',', ';', ':', '-', '–', '—', '.', ' ');
    }

    // 0..1 — how much this reads as a person's name. A score, not a gate: the old boolean predicate
    // required 2–4 tokens, rejecting mononyms and single-initial tokens that Meet guests commonly have.
    public static double PersonScore(string raw)
    {
        var n = Clean(raw);
        if (n.Length < 2 || n.Length > 60) return 0;
        if (Regex.IsMatch(n, @"\d")) return 0;
        if (Regex.IsMatch(n, @"[@|•·<>/\\{}=+*#~^]|https?:", RegexOptions.IgnoreCase)) return 0;
        var words = n.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0 || words.Length > 5) return 0;
        if (NonPersonExact.Contains(n)) return 0;
        if (words.Any(w => UiWords.Contains(w))) return 0;
        if (words.All(w => RoleWords.Contains(w.ToLowerInvariant()))) return 0;
        if (Descriptive.IsMatch(n)) return 0; // "Content shared by <name>" is not a roster row

        // Capitalised tokens read as names; a lowercase particle is fine inside one ("van Dijk").
        int capped = 0;
        for (int i = 0; i < words.Length; i++)
        {
            if (char.IsUpper(words[i][0]) || (i > 0 && Particles.Contains(words[i]))) capped++;
        }
        double score = 0.5 + 0.35 * ((double)capped / words.Length);
        if (words.Length >= 2) score += 0.15;
        return Math.Min(1.0, score);
    }

    public static bool IsPerson(string raw, double threshold = 0.6) => PersonScore(raw) >= threshold;
}

internal static class Heuristics
{
    // Kept only as a confirmation signal, demoted below the structural strategies. English-only by
    // nature, so it can never be the primary path.
    private static readonly Regex SpeakingPhrase = new(
        @"^(?<n>.{2,60}?)[,]?\s+is\s+(speaking|talking)\b|^Speaking[:,]?\s+(?<m>.{2,60})$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Is this window actually IN a call right now? Every meeting UI has a leave/hangup control and
    // mic/camera toggles; a Slack channel, a Chrome tab, or an idle Teams chat does not.
    //
    // Without this gate the agent scraped whatever window it was pointed at: a live Google Meet
    // yielded Chrome's toolbar ("Back", "Forward", "Reload") as the roster, and with no meeting
    // open at all it emitted Slack's message-formatting toolbar ("Bold", "Italic", "Code") as a
    // 10-person roster. Those strings score 0.74–1.00 — identical to real names — so no amount of
    // name-shape scoring can reject them. The only reliable discriminator is whether the window
    // contains in-call controls.
    //
    // Deliberately matched on SEVERAL independent controls, so one stray label cannot open the
    // gate, and kept to the few words that are near-universal across meeting clients. This is the
    // one place English strings are unavoidable — a localized client will simply yield no names
    // and fall through to AI inference, which is the documented degradation, not a break.
    // Measured against the real button labels of each client. Zoom is the reason for most of the
    // additions: its leave button is often bare "End", and its controls are "Start Video" /
    // "Stop Video" / "Mute" rather than the Teams phrasings this originally encoded. A window that
    // matches neither contributes NOTHING (Observe returns empty), so a miss here is a silent
    // whole-meeting failure, not a degradation.
    private static readonly Regex LeaveControl = new(
        @"^(leave|hang ?up|end|disconnect|exit)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CallControl = new(
        @"\b(mute|unmute)\b|\b(start|stop|turn) (the )?(camera|video|audio)\b"
        + @"|\bturn (camera|video) (on|off)\b|\bshare (content|screen)\b"
        + @"|\bmicrophone\b|\bcamera\b|\braise (your )?hand\b|\bparticipants?\b|\bpeople\b"
        + @"|\bgallery view\b|\bspeaker view\b|\brecord(ing)?\b|\bbreakout\b|\breactions\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static bool LooksInCall(List<Node> nodes)
    {
        bool leave = false;
        int controls = 0;
        foreach (var n in nodes)
        {
            var name = (n.Name ?? "").Trim();
            if (name.Length is 0 or > 40) continue;
            if (LeaveControl.IsMatch(name)) leave = true;
            else if (CallControl.IsMatch(name)) controls++;
        }
        // A leave control plus at least one other call control: Slack's toolbar has neither.
        return leave && controls >= 1;
    }

    public static Observation Observe(
        List<Node> nodes, string family, HashSet<string> knownNames,
        Dictionary<string, string> lastDecorations)
    {
        // The in-call check used to RETURN EARLY, contributing nothing. That made a single missed
        // control label a silent whole-meeting failure — measured three times in a row, zero roster
        // events. It now only *downgrades*: a real participants panel is still reported (the JS side
        // re-validates every roster through rosterIsTrustworthy, so pollution is caught there), while
        // a tile-grid guess from a window that does not look like a call is still discarded — that
        // was the actual Slack/Chrome poisoning case.
        bool inCall = LooksInCall(nodes);

        var (roster, source) = FindRoster(nodes, family);
        int expected = FindExpectedCount(nodes);
        int maxDepth = 0;
        foreach (var n in nodes) if (n.Depth > maxDepth) maxDepth = n.Depth;

        // Not in a call -> contribute NOTHING. Briefly relaxed to "report a panel anyway", which a
        // live test immediately disproved: an ordinary Gemini web page yielded the shape of a
        // participants panel and produced the roster ["Targets: LinkedIn", "The Tech: Undetected
        // headless browsers"] — and that junk passes every downstream guard (isPersonName true,
        // rosterIsTrustworthy true), so it would have poisoned the closed set. The gate was never
        // the cause of the empty rosters; the agent was blind (missing native DLLs). Keep it strict.
        if (!inCall) return new Observation(null, new List<string>(), null, 0, false, nodes.Count, maxDepth);

        // The pool of names to test for decoration: this poll's roster plus everything seen
        // earlier in the meeting (the panel is often closed while people talk).
        var pool = new HashSet<string>(roster, StringComparer.OrdinalIgnoreCase);
        foreach (var n in knownNames) pool.Add(n);

        var active = FindActiveByDecoration(nodes, pool, lastDecorations)
                     ?? FindActiveByPhrase(nodes, pool);

        return new Observation(active, roster, source, expected, true, nodes.Count, maxDepth);
    }

    // Roster = the best-scoring List/DataGrid/Tree whose ListItem children look like people.
    // Falls back to the tile grid (any sibling group of person-shaped nodes) at lower confidence,
    // because Meet's participants panel is usually CLOSED while the tile grid is always present.
    // Browser chrome lives near the top of the tree; web content (where a meeting UI renders) is
    // far deeper. Measured: live Teams roster rows sit at depth 14, while Chrome's Back/Forward/
    // Reload toolbar sits at depth ≤5. A live Google Meet produced a "roster" of
    // ["Back","Forward","Reload","Work","History Navigation"] — all scoring 0.85–1.00, i.e.
    // indistinguishable from real names — because the agent walks the WHOLE Chrome window and the
    // biggest person-shaped group wins. This gate is what separates the two.
    private const int MinWebContentDepth = 6;

    private static (List<string> Names, string? Source) FindRoster(List<Node> nodes, string family)
    {
        var byParent = new Dictionary<int, List<Node>>();
        foreach (var n in nodes)
        {
            if (n.Parent < 0) continue;
            if (!byParent.TryGetValue(n.Parent, out var list)) byParent[n.Parent] = list = new List<Node>();
            list.Add(n);
        }

        // In a browser the meeting is one tab among arbitrary other content, so demand stronger
        // evidence: real display names are usually "First Last", whereas toolbar and sidebar labels
        // are single words ("Back", "Work", "Mentions", "REPORTS").
        bool strict = family == "browser";

        List<string> bestPanel = new(), bestGrid = new();
        foreach (var (parentIdx, children) in byParent)
        {
            if (children.Count < 2) continue;
            // Browser chrome is shallow; a participants panel is deep inside the web view.
            if (children[0].Depth < MinWebContentDepth) continue;

            var names = children
                .Where(c => !c.Offscreen)
                .Select(c => NameHeuristics.Clean(c.Name))
                .Where(s => s.Length > 0 && NameHeuristics.IsPerson(s))
                .Where(s => !strict || s.Contains(' '))   // browser: require a multi-word name
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (names.Count < 2) continue;
            // Mostly-people groups only: a toolbar with one person-ish label is not a roster.
            if ((double)names.Count / children.Count < 0.5) continue;

            var parent = parentIdx < nodes.Count ? nodes[parentIdx] : null;
            // Either the container is an accessible collection, or its children are item-shaped.
            // Menu/MenuItem is included because that is what LIVE TEAMS actually emits for its
            // participant rows (verified against a real call) — restricting this to List/ListItem
            // is why the roster came back empty. "Group" is NOT accepted as a container: it is so
            // generic that Chrome's own toolbar qualified, which is how the Meet pollution got in.
            bool listLike =
                (parent is not null && parent.ControlType is "List" or "DataGrid" or "Tree" or "Table" or "Menu")
                || children.Count(c => c.ControlType is "ListItem" or "TreeItem" or "DataItem" or "MenuItem") >= 2;

            if (listLike) { if (names.Count > bestPanel.Count) bestPanel = names; }
            // The tile-grid fallback needs the SAME item-role evidence as a panel. Without it, any
            // sibling group of capitalised words qualified — Slack's formatting toolbar
            // ("Bold", "Italic", "Underline", "Code") was emitted as a 10-person roster.
            else if (names.Count > bestGrid.Count
                     && children.Count(c => c.ControlType is "ListItem" or "MenuItem" or "Button" or "Image") >= 2)
            {
                bestGrid = names;
            }
        }

        if (bestPanel.Count >= 2) return (bestPanel.Take(50).ToList(), "participants-panel");
        if (bestGrid.Count >= 2) return (bestGrid.Take(50).ToList(), "tile-grid");
        return (new List<string>(), null);
    }

    // PRIMARY, locale-proof: a known name with something appended is that person with a status
    // decoration ("Priya Shah is speaking", "Priya Shah, spricht", "Priya Shah 🔊" — all equal).
    // Matching against a name we already extracted means no English string is involved.
    private static Candidate? FindActiveByDecoration(
        List<Node> nodes, HashSet<string> pool, Dictionary<string, string> lastDecorations)
    {
        if (pool.Count == 0) return null;
        var decorated = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var node in nodes)
        {
            var raw = (node.Name ?? "").Trim();
            if (raw.Length < 3 || raw.Length > 160 || node.Offscreen) continue;
            foreach (var name in pool)
            {
                if (raw.Length <= name.Length) continue;
                if (raw.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                // Ignore a bare name that merely sits inside a longer OTHER name.
                var rest = Regex.Replace(raw, Regex.Escape(name), " ", RegexOptions.IgnoreCase).Trim();
                if (rest.Length == 0 || NameHeuristics.IsPerson(rest)) continue;
                decorated[name] = raw;
                break;
            }
        }

        // Exactly one decorated participant is a clean signal; several means the UI decorates
        // everyone (mute badges on every tile) and tells us nothing about who is talking.
        if (decorated.Count != 1)
        {
            foreach (var kv in decorated) lastDecorations[kv.Key] = kv.Value;
            return null;
        }

        var (who, label) = (decorated.First().Key, decorated.First().Value);
        // FIRST SIGHT IS A BASELINE, NOT A CHANGE. This used to count "never seen before" as a
        // change, so the very first poll of every meeting emitted an active-speaker event for
        // whichever tile carried a decoration — measured: 30 of 37 real active-speaker events share
        // the exact timestamp of the first roster event, usually naming the user's own tile
        // ("Sagar"). The pipeline then voted that one event onto a whole remote voice. Only a
        // decoration that CHANGED on a tile we had already seen says anything about speech.
        bool seenBefore = lastDecorations.TryGetValue(who, out var prev);
        lastDecorations[who] = label;
        return seenBefore && prev != label ? new Candidate(who, 0.75, "suffix-delta") : null;
    }

    // Last resort: the old English phrase match, now only a confirmation.
    private static Candidate? FindActiveByPhrase(List<Node> nodes, HashSet<string> pool)
    {
        foreach (var node in nodes)
        {
            var m = SpeakingPhrase.Match(node.Name ?? "");
            if (!m.Success) continue;
            var raw = m.Groups["n"].Success && m.Groups["n"].Value.Length > 0 ? m.Groups["n"].Value : m.Groups["m"].Value;
            var name = NameHeuristics.Clean(raw);
            if (name.Length == 0 || !NameHeuristics.IsPerson(name)) continue;
            if (string.Equals(name, "You", StringComparison.OrdinalIgnoreCase)) continue;
            // MUST be someone in the meeting. Accepting unknown names let a Chrome window's
            // "Workspaces" label be reported as the active speaker in a live Teams call — an
            // active speaker who is not a participant is a contradiction, so reject rather than
            // down-weight. personScore cannot help here: "Workspaces" scores the same 0.85 as a
            // real mononym like "Sagar".
            if (!pool.Contains(name)) continue;
            return new Candidate(name, 0.65, "phrase");
        }
        return null;
    }

    // "12 participants" / "Participants (5)" / "View all 15 members" → 12 / 5 / 15. Returns 0 when
    // the UI does not expose a count, which is the COMMON case: live Teams labels its button just
    // "People" with no number, so 0 means "unknown", never "nobody".
    //
    // Deliberately strict. The same window contains "Elapsed time 18:56" and a bare clock "23:08";
    // a looser keyword-then-any-digits rule matched those and reported a 5-person call as having
    // 18 or 23 participants. The count must be ADJACENT to the keyword, and clock-shaped values
    // (h:mm) are excluded outright.
    private static readonly Regex CountAdjacent = new(
        @"(?<n>\d{1,3})\s*(participants?|people|attendees?|members?)\b"
        + @"|(participants?|people|attendees?|members?)\D{0,8}?(?<m>\d{1,3})\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static int FindExpectedCount(List<Node> nodes)
    {
        foreach (var node in nodes)
        {
            var name = node.Name ?? "";
            if (name.Length is 0 or > 60) continue;
            if (Regex.IsMatch(name, @"\d{1,2}:\d{2}")) continue;      // "18:56", "23:08" — a clock
            if (Regex.IsMatch(name, @"\b(elapsed|time|duration|unread|message)\b", RegexOptions.IgnoreCase)) continue;
            var m = CountAdjacent.Match(name);
            if (!m.Success) continue;
            var digits = m.Groups["n"].Success ? m.Groups["n"].Value : m.Groups["m"].Value;
            if (int.TryParse(digits, out var v) && v is > 0 and < 500) return v;
        }
        return 0;
    }
}
