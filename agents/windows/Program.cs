// Your Call AI — Windows active-speaker agent (§7 Layer 1).
// Reads meeting UIs via UI Automation and emits one JSON line per observation to stdout:
//   {"ts":1720512003120,"type":"active-speaker","name":"Priya Shah"}
//   {"ts":1720512000000,"type":"roster","names":["Priya Shah","Sam Ortiz"]}
// UIA clients connecting is what makes Chromium build its a11y tree — no extra flags needed.
// All selector heuristics live in the *Heuristics classes: when Meet/Teams change their UI,
// fix it there and bump HeuristicsVersion.
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Automation;

internal static class Agent
{
    private const string HeuristicsVersion = "2026-07-meet1-zoom1-teams1";
    private static string? _lastSpeaker;
    private static string _lastRosterKey = "";

    private static void Main(string[] args)
    {
        Console.Error.WriteLine($"[agent] started, heuristics={HeuristicsVersion}");
        while (true)
        {
            try { Poll(); }
            catch (Exception ex) { Console.Error.WriteLine($"[agent] poll error: {ex.Message}"); }
            Thread.Sleep(500); // ~2×/s
        }
    }

    private static void Poll()
    {
        foreach (AutomationElement window in AutomationElement.RootElement.FindAll(
                     TreeScope.Children, Condition.TrueCondition))
        {
            string title;
            try { title = window.Current.Name ?? ""; } catch { continue; }

            Observation? obs = null;
            if (Regex.IsMatch(title, @"^Meet [–-] ") || title.Contains("Google Meet"))
                obs = MeetHeuristics.Observe(window);
            else if (title.Contains("Zoom Meeting"))
                obs = ZoomHeuristics.Observe(window);
            else if (title.Contains("Microsoft Teams") && (title.Contains("Meeting") || title.Contains("Call")))
                obs = TeamsHeuristics.Observe(window);

            if (obs is null) continue;
            Emit(obs);
            return; // one meeting window is enough per poll
        }
    }

    private static void Emit(Observation obs)
    {
        long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (obs.ActiveSpeaker is not null && obs.ActiveSpeaker != _lastSpeaker)
        {
            _lastSpeaker = obs.ActiveSpeaker;
            Console.WriteLine(JsonSerializer.Serialize(new { ts, type = "active-speaker", name = obs.ActiveSpeaker }));
            Console.Out.Flush();
        }
        if (obs.Roster.Count > 0)
        {
            var key = string.Join("|", obs.Roster.OrderBy(x => x));
            if (key != _lastRosterKey)
            {
                _lastRosterKey = key;
                Console.WriteLine(JsonSerializer.Serialize(new { ts, type = "roster", names = obs.Roster }));
                Console.Out.Flush();
            }
        }
    }
}

internal sealed record Observation(string? ActiveSpeaker, List<string> Roster);

internal static class UiaHelpers
{
    // Collect Name properties of all descendants matching a predicate; bounded to keep polls cheap.
    public static List<string> CollectNames(AutomationElement root, Func<string, bool> predicate, int max = 400)
    {
        var results = new List<string>();
        var walker = TreeWalker.ContentViewWalker;
        var stack = new Stack<AutomationElement>();
        stack.Push(root);
        int visited = 0;
        while (stack.Count > 0 && visited++ < max)
        {
            var el = stack.Pop();
            string name = "";
            try { name = el.Current.Name ?? ""; } catch { }
            if (name.Length > 0 && name.Length < 120 && predicate(name)) results.Add(name);
            try
            {
                for (var child = walker.GetFirstChild(el); child != null; child = walker.GetNextSibling(child))
                    stack.Push(child);
            }
            catch { }
        }
        return results;
    }
}

// ---- Google Meet in Chrome/Edge -------------------------------------------------
// Meet's a11y tree labels the speaking participant's tile/status. Known patterns
// (verified empirically, revisit when Meet ships UI changes):
//   "<Name> is speaking"      — spoken-feedback status on the active tile
//   "Presenting" tiles and "You" are excluded from active-speaker attribution.
// Roster: participant tiles expose plain-name elements inside the call region.
internal static class MeetHeuristics
{
    private static readonly Regex Speaking = new(@"^(?<n>.{2,60}?) is speaking\b", RegexOptions.Compiled);

    public static Observation Observe(AutomationElement window)
    {
        string? active = null;
        var roster = new List<string>();
        var names = UiaHelpers.CollectNames(window, _ => true);
        foreach (var n in names)
        {
            var m = Speaking.Match(n);
            if (m.Success) { active ??= Clean(m.Groups["n"].Value); continue; }
            // Roster candidates: short plain names in the participants panel ("Priya Shah")
            if (Regex.IsMatch(n, @"^[\p{L}][\p{L}'.-]+( [\p{L}][\p{L}'.-]+){1,3}$") && n != "You")
                roster.Add(n);
        }
        return new Observation(active, roster.Distinct().Take(50).ToList());
    }

    private static string Clean(string s) => s.Trim().TrimEnd('.');
}

// ---- Zoom desktop ---------------------------------------------------------------
// Zoom's UIA tree is sparse; active speaker is best-effort from elements named
// "Speaking: <name>" or the participant list items "<name>, (Host)" etc.
internal static class ZoomHeuristics
{
    private static readonly Regex Speaking = new(@"^Speaking[:,]?\s+(?<n>.{2,60})$", RegexOptions.Compiled);

    public static Observation Observe(AutomationElement window)
    {
        string? active = null;
        var roster = new List<string>();
        foreach (var n in UiaHelpers.CollectNames(window, _ => true))
        {
            var m = Speaking.Match(n);
            if (m.Success) { active ??= m.Groups["n"].Value.Trim(); continue; }
            var li = Regex.Match(n, @"^(?<n>[\p{L}][\p{L} '.-]{2,50}?)(,| \()\s*(Host|Co-host|Guest|me\b)", RegexOptions.IgnoreCase);
            if (li.Success) roster.Add(li.Groups["n"].Value.Trim());
        }
        return new Observation(active, roster.Distinct().Take(50).ToList());
    }
}

// ---- Microsoft Teams desktop ----------------------------------------------------
// Teams (WebView2) exposes "<name>, muted/unmuted, ..." roster rows and marks the
// active speaker with "<name> is speaking"-style status text. Best-effort.
internal static class TeamsHeuristics
{
    private static readonly Regex Speaking = new(@"^(?<n>.{2,60}?),?\s+is speaking\b", RegexOptions.Compiled);

    public static Observation Observe(AutomationElement window)
    {
        string? active = null;
        var roster = new List<string>();
        foreach (var n in UiaHelpers.CollectNames(window, _ => true))
        {
            var m = Speaking.Match(n);
            if (m.Success) { active ??= m.Groups["n"].Value.Trim(); continue; }
            var li = Regex.Match(n, @"^(?<n>[\p{L}][\p{L} '.-]{2,50}?),\s+(Muted|Unmuted|Organizer|Presenter|Attendee)\b", RegexOptions.IgnoreCase);
            if (li.Success) roster.Add(li.Groups["n"].Value.Trim());
        }
        return new Observation(active, roster.Distinct().Take(50).ToList());
    }
}
