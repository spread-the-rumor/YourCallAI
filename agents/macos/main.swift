// Your Call AI — macOS active-speaker agent (§7 Layer 1).
// Reads meeting UIs via the AX API and emits one JSON line per observation to stdout.
// Requires the Accessibility permission (main app deep-links to System Settings).
// Known caveat: Chrome Guest/Incognito windows expose no AX tree — silently unavailable.
//
// DESIGN: match on STRUCTURE, never on English UI strings — mirrors agents/windows/Program.cs.
// The previous version keyed off the literal phrase "<Name> is speaking" and gated windows on
// their title, so browser-hosted Teams/Zoom were never handled and any UI rewording or a
// non-English locale silently produced zero names. Instead:
//   - Roster: find the AX group whose children mostly look like people's names (that is what a
//     participants panel IS, in every language).
//   - Active speaker: DECORATION DELTA — we already know the clean names, so a node reading
//     "<known name> + extra" is that person with a status appended.
// Run with --dump to print the raw AX tree of every candidate window and exit.
import Foundation
import ApplicationServices
import AppKit

let heuristicsVersion = "2026-08-structural2-incall"
let dumpMode = CommandLine.arguments.contains("--dump")
if !dumpMode {
    FileHandle.standardError.write("[agent] started, heuristics=\(heuristicsVersion)\n".data(using: .utf8)!)
}

var lastSpeaker: String? = nil
var lastRosterKey = ""
// Names seen earlier in the meeting: the participants panel is usually closed while people talk,
// so the decoration test needs the names it learned when the panel was last open.
var knownNames = Set<String>()
var lastDecorations: [String: String] = [:]

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

struct AXNode {
    let name: String
    let role: String
    let depth: Int
    let index: Int
    let parent: Int
}

// Walk the AX tree keeping STRUCTURE (role, parent, depth), not just a flat list of strings —
// finding "a group of people" is what makes the roster heuristic language-independent.
func axNodes(of element: AXUIElement, limit: Int = 400) -> [AXNode] {
    var results: [AXNode] = []
    var queue: [(AXUIElement, Int, Int)] = [(element, 0, -1)]
    while !queue.isEmpty && results.count < limit {
        let (el, depth, parent) = queue.removeFirst()
        var role = ""
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleRef) == .success,
           let r = roleRef as? String { role = r }

        // Any of these can carry the participant's name depending on the app.
        var label = ""
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success,
               let s = value as? String, s.count > 1, s.count < 160 {
                label = s
                break
            }
        }

        let myIndex = results.count
        results.append(AXNode(name: label, role: role, depth: depth, index: myIndex, parent: parent))
        if depth > 24 { continue }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
           let kids = children as? [AXUIElement] {
            for kid in kids { queue.append((kid, depth + 1, myIndex)) }
        }
    }
    return results
}

// Name shaping — mirrors NameHeuristics in Program.cs and src/roster.js. Keep the three in step;
// the JS side re-validates whatever we emit, so it is the final safety net.
// Shared regex helper — used by both NameHeuristics and Heuristics, so it lives at file scope.
func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

enum NameHeuristics {
    static let roleWords: Set<String> = [
        "host", "co-host", "cohost", "guest", "organizer", "organiser", "presenter", "attendee",
        "me", "you", "muted", "unmuted", "pinned", "presenting", "speaking", "owner", "moderator",
    ]
    static let uiWords: Set<String> = [
        "turn", "mute", "unmute", "join", "leave", "share", "sharing", "stop", "start", "camera",
        "video", "audio", "more", "options", "raise", "hand", "chat", "people", "participants",
        "reactions", "settings", "close", "open", "search", "invite", "add", "copy", "record",
        "recording", "transcript", "captions", "present", "screen", "window", "meeting", "call",
        "everyone", "waiting", "room", "breakout", "pin", "spotlight", "remove", "admit",
    ]
    static let particles: Set<String> = [
        "van", "von", "de", "del", "della", "da", "di", "du", "la", "le", "bin", "ibn", "al", "el", "ter", "ten", "op",
    ]
    // Exact labels that are never a person but score like a short name, so personScore cannot
    // reject them ("System" is a window-menu artifact seen live beside Teams' participant rows;
    // "Workspaces" is browser chrome that was actually reported as an active speaker). Whole-string
    // match only, so someone named "Nav" is unaffected. Mirrors NON_PERSON_EXACT in src/roster.js.
    static let nonPersonExact: Set<String> = [
        "system", "workspaces", "workspace", "profile", "default", "guest", "admin",
        "administrator", "untitled", "new tab", "home", "general", "unknown", "me", "you",
        "everyone", "notifications", "menu", "toolbar", "main", "body", "null",
    ]
    static let parens = try! NSRegularExpression(pattern: "\\([^()]*\\)|\\[[^\\]]*\\]")
    static let roleTail = try! NSRegularExpression(
        pattern: "[,\\-–—]\\s*(" + roleWords.joined(separator: "|") + ")\\b.*$",
        options: [.caseInsensitive])
    // A comma-separated field that reads as UI status, not a person. Words taken from REAL Teams
    // labels captured live on Windows:
    //   "Carlos Brito, Has control of production tools, Context menu is available"
    // roleTail alone only stripped single role words, so these clauses survived and every real
    // name blew the ≤5-token limit and scored 0. Mirrors STATUS_CLAUSE_RE in src/roster.js.
    static let statusClause = try! NSRegularExpression(
        pattern: "\\b(has|is|are|was|available|control|context|menu|video|camera|mic|microphone"
            + "|muted|unmuted|sharing|shared|speaking|presenting|pinned|spotlight|raised|hand"
            + "|reaction|status|indicator|tools|myself|content|elapsed|encryption)\\b",
        options: [.caseInsensitive])
    // Descriptive phrases that merely CONTAIN a name ("Content shared by Hernan Zapata").
    static let descriptive = try! NSRegularExpression(
        pattern: "\\b(shared|share|by|from|to|with|via|presented|pinned)\\b", options: [.caseInsensitive])

    static func clean(_ raw: String) -> String {
        var s = raw
        // Drop emoji / symbol glyphs that ride along with status badges.
        s = String(s.unicodeScalars.filter { !($0.properties.isEmoji && $0.properties.isEmojiPresentation)
            && $0 != "\u{FE0F}" && $0 != "\u{200D}" })
        for re in [parens, roleTail] {
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        }

        // Keep the first comma-separated field that looks like a name; the rest is status. Teams
        // prefixes its own tile ("Myself video, Sagar, …"), so a leading status field is skipped
        // rather than mistaken for the name.
        if s.contains(",") {
            let fields = s.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if let named = fields.first(where: { !matches(statusClause, $0) }) {
                s = named
            } else if let first = fields.first {
                s = first
            }
        }

        s = s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        return s.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-–—."))
    }

    // 0..1 — a score, not a gate: the old predicate required 2–4 tokens and so rejected mononyms
    // and single-initial tokens, which Meet guests commonly have.
    static func personScore(_ raw: String) -> Double {
        let n = clean(raw)
        if n.count < 2 || n.count > 60 { return 0 }
        if n.rangeOfCharacter(from: .decimalDigits) != nil { return 0 }
        if n.rangeOfCharacter(from: CharacterSet(charactersIn: "@|•·<>/\\{}=+*#~^")) != nil { return 0 }
        let words = n.split(separator: " ").map(String.init)
        if words.isEmpty || words.count > 5 { return 0 }
        let lowered = words.map { $0.lowercased() }
        if nonPersonExact.contains(n.lowercased()) { return 0 }
        if lowered.contains(where: { uiWords.contains($0) }) { return 0 }
        if lowered.allSatisfy({ roleWords.contains($0) }) { return 0 }
        // "Content shared by Hernan Zapata" merely contains a name; it is not a roster row.
        if matches(descriptive, n) { return 0 }

        var capped = 0
        for (i, w) in words.enumerated() {
            if let f = w.first, f.isUppercase { capped += 1 }
            else if i > 0 && particles.contains(w.lowercased()) { capped += 1 }
        }
        var score = 0.5 + 0.35 * (Double(capped) / Double(words.count))
        if words.count >= 2 { score += 0.15 }
        return min(1.0, score)
    }

    static func isPerson(_ raw: String, threshold: Double = 0.6) -> Bool {
        personScore(raw) >= threshold
    }
}

struct Candidate {
    let name: String
    let confidence: Double
    let strategy: String
}

enum Heuristics {
    // Kept only as a confirmation signal — English-only by nature, so never the primary path.
    static let speaking = try! NSRegularExpression(
        pattern: "^(.{2,60}?),?\\s+is\\s+(?:speaking|talking)\\b", options: [.caseInsensitive])

    // Is this window actually IN a call right now? Every meeting UI has a leave/hangup control and
    // mic/camera toggles; a Slack channel, a browser tab, or an idle chat does not.
    //
    // Without this gate the agent scraped whatever window it was pointed at: on Windows a live
    // Google Meet yielded Chrome's toolbar ("Back", "Forward", "Reload") as the roster, and with no
    // meeting open at all it emitted Slack's formatting toolbar ("Bold", "Italic", "Code") as a
    // 10-person roster. Those strings score 0.74–1.00 — identical to real names — so name-shape
    // scoring cannot reject them. In-call controls are the only reliable discriminator.
    //
    // This is the one place English strings are unavoidable; a localized client yields no names and
    // falls through to AI inference, which is the documented degradation, not a break.
    // Keep in step with Program.cs. Widened for Zoom, whose leave button is often bare "End" and
    // whose controls read "Start Video"/"Mute" rather than the Teams phrasings originally encoded.
    // A window matching neither contributes nothing at all, so a miss is a silent whole-meeting
    // failure. The leave+control conjunction is what keeps ordinary windows ("End" in Explorer,
    // "Exit"/"Forward" in a mail client) from qualifying.
    static let leaveControl = try! NSRegularExpression(
        pattern: "^(leave|hang ?up|end|disconnect|exit)\\b",
        options: [.caseInsensitive])
    static let callControl = try! NSRegularExpression(
        pattern: "\\b(mute|unmute)\\b|\\b(start|stop|turn) (the )?(camera|video|audio)\\b"
            + "|\\bturn (camera|video) (on|off)\\b|\\bshare (content|screen)\\b"
            + "|\\bmicrophone\\b|\\bcamera\\b|\\braise (your )?hand\\b"
            + "|\\bparticipants?\\b|\\bpeople\\b"
            + "|\\bgallery view\\b|\\bspeaker view\\b|\\brecord(ing)?\\b|\\bbreakout\\b|\\breactions\\b",
        options: [.caseInsensitive])

    static func looksInCall(_ nodes: [AXNode]) -> Bool {
        var leave = false
        var controls = 0
        for node in nodes {
            let name = node.name.trimmingCharacters(in: .whitespaces)
            if name.isEmpty || name.count > 40 { continue }
            if matches(leaveControl, name) { leave = true }
            else if matches(callControl, name) { controls += 1 }
        }
        // A leave control plus at least one other call control: Slack's toolbar has neither.
        return leave && controls >= 1
    }

    // Roster = the best sibling group whose members mostly look like people. An AX list/table/
    // outline scores as the participants panel; anything else is treated as the tile grid, which
    // matters because Meet's panel is usually closed while its tile grid is always present.
    static func findRoster(_ nodes: [AXNode]) -> (names: [String], source: String?) {
        var byParent: [Int: [AXNode]] = [:]
        for n in nodes where n.parent >= 0 { byParent[n.parent, default: []].append(n) }

        var bestPanel: [String] = []
        var bestGrid: [String] = []
        for (parentIdx, children) in byParent {
            if children.count < 2 { continue }
            var seen = Set<String>()
            var names: [String] = []
            for c in children {
                let cleaned = NameHeuristics.clean(c.name)
                if cleaned.isEmpty || !NameHeuristics.isPerson(cleaned) { continue }
                if seen.insert(cleaned.lowercased()).inserted { names.append(cleaned) }
            }
            if names.count < 2 { continue }
            // Mostly-people groups only: a toolbar with one person-ish label is not a roster.
            if Double(names.count) / Double(children.count) < 0.5 { continue }

            let parentRole = parentIdx < nodes.count ? nodes[parentIdx].role : ""
            // AXMenu/AXMenuItem included because that is what Teams actually emits for its
            // participant rows on Windows (verified live via UIA: Menu > MenuItem, NOT List >
            // ListItem). Restricting to list roles is what made the roster come back empty there,
            // and the Electron-based clients share a rendering model across platforms.
            let listRoles = ["AXList", "AXTable", "AXOutline", "AXGrid", "AXMenu", "AXGroup"]
            let itemRoles = ["AXRow", "AXCell", "AXStaticText", "AXGroup", "AXMenuItem"]
            let listLike = listRoles.contains(parentRole)
                || children.filter { itemRoles.contains($0.role) }.count >= 2

            // The tile-grid fallback needs the SAME item-role evidence as a panel. Without it any
            // sibling group of capitalised words qualified — Slack's formatting toolbar became a
            // 10-person roster on Windows.
            let gridItemRoles = ["AXRow", "AXCell", "AXButton", "AXImage", "AXMenuItem"]
            let gridItems = children.filter { gridItemRoles.contains($0.role) }.count

            if listLike {
                if names.count > bestPanel.count { bestPanel = names }
            } else if names.count > bestGrid.count && gridItems >= 2 {
                bestGrid = names
            }
        }
        if bestPanel.count >= 2 { return (Array(bestPanel.prefix(50)), "participants-panel") }
        if bestGrid.count >= 2 { return (Array(bestGrid.prefix(50)), "tile-grid") }
        return ([], nil)
    }

    // PRIMARY, locale-proof: a known name with something appended is that person with a status
    // decoration. Matches against a name WE extracted, so no English string is involved.
    static func findActiveByDecoration(_ nodes: [AXNode], pool: Set<String>) -> Candidate? {
        if pool.isEmpty { return nil }
        var decorated: [String: String] = [:]
        for node in nodes {
            let raw = node.name.trimmingCharacters(in: .whitespaces)
            if raw.count < 3 || raw.count > 160 { continue }
            for name in pool where raw.count > name.count {
                guard raw.range(of: name, options: .caseInsensitive) != nil else { continue }
                let rest = raw.replacingOccurrences(of: name, with: " ", options: .caseInsensitive)
                    .trimmingCharacters(in: .whitespaces)
                // A bare name sitting inside a longer OTHER name is not a decoration.
                if rest.isEmpty || NameHeuristics.isPerson(rest) { continue }
                decorated[name] = raw
                break
            }
        }
        // Exactly one decorated participant is a clean signal; several means the UI decorates
        // everyone (mute badges on every tile) and says nothing about who is talking.
        guard decorated.count == 1, let (who, label) = decorated.first else {
            for (k, v) in decorated { lastDecorations[k] = v }
            return nil
        }
        let changed = lastDecorations[who] != label
        lastDecorations[who] = label
        return changed ? Candidate(name: who, confidence: 0.75, strategy: "suffix-delta") : nil
    }

    static func findActiveByPhrase(_ nodes: [AXNode], pool: Set<String>) -> Candidate? {
        for node in nodes {
            let n = node.name
            let range = NSRange(n.startIndex..., in: n)
            guard let m = speaking.firstMatch(in: n, range: range),
                  let r = Range(m.range(at: 1), in: n) else { continue }
            let name = NameHeuristics.clean(String(n[r]))
            if name.isEmpty || !NameHeuristics.isPerson(name) { continue }
            if name.caseInsensitiveCompare("You") == .orderedSame { continue }
            // MUST be someone in the meeting. Accepting unknown names let a Chrome window's
            // "Workspaces" label be reported as the active speaker in a live Teams call — an
            // active speaker who is not a participant is a contradiction, so reject rather than
            // down-weight. personScore cannot help: "Workspaces" scores like a real mononym.
            if !pool.contains(name) { continue }
            return Candidate(name: name, confidence: 0.65, strategy: "phrase")
        }
        return nil
    }

    // Returns 0 when the UI exposes no count, which is the COMMON case: live Teams labels its
    // button just "People" with no number. 0 means "unknown", never "nobody".
    //
    // Deliberately strict. The same window carries "Elapsed time 18:56" and a bare clock "23:08";
    // a keyword-then-any-digits rule matched those and reported a 5-person call as 18 or 23. The
    // count must be ADJACENT to the keyword, and clock-shaped values are excluded outright.
    static let countAdjacent = try! NSRegularExpression(
        pattern: "(\\d{1,3})\\s*(?:participants?|people|attendees?|members?)\\b"
            + "|(?:participants?|people|attendees?|members?)\\D{0,8}?(\\d{1,3})\\b",
        options: [.caseInsensitive])
    static let clockLike = try! NSRegularExpression(pattern: "\\d{1,2}:\\d{2}")
    static let timeWords = try! NSRegularExpression(
        pattern: "\\b(elapsed|time|duration|unread|message)\\b", options: [.caseInsensitive])

    static func expectedCount(_ nodes: [AXNode]) -> Int {
        for node in nodes {
            let n = node.name
            if n.isEmpty || n.count > 60 { continue }
            if matches(clockLike, n) || matches(timeWords, n) { continue }
            guard let m = countAdjacent.firstMatch(in: n, range: NSRange(n.startIndex..., in: n)) else { continue }
            for group in 1...2 {
                if let r = Range(m.range(at: group), in: n), let v = Int(n[r]), v > 0, v < 500 {
                    return v
                }
            }
        }
        return 0
    }
}

// Apps that can host a meeting. Classified by APP, not by window title, so a browser-hosted
// Teams/Zoom call is examined instead of being skipped for lacking a magic word in its title.
let meetingApps: Set<String> = [
    "Google Chrome", "Google Chrome Beta", "Google Chrome Canary", "Chromium",
    "Microsoft Edge", "Brave Browser", "Opera", "Vivaldi", "Arc",
    "zoom.us", "Zoom", "Microsoft Teams", "Microsoft Teams (work or school)",
]

func candidateWindows() -> [(AXUIElement, String, String)] {
    var out: [(AXUIElement, String, String)] = []
    for runningApp in NSWorkspace.shared.runningApplications {
        guard let name = runningApp.localizedName, meetingApps.contains(name) else { continue }
        let appEl = AXUIElementCreateApplication(runningApp.processIdentifier)
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let windows = windowsRef as? [AXUIElement] else { continue }
        for win in windows {
            var titleRef: CFTypeRef?
            AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleRef)
            out.append((win, name, (titleRef as? String) ?? ""))
        }
    }
    return out
}

if dumpMode {
    for (win, app, title) in candidateWindows() {
        emit(["type": "window", "app": app, "title": title])
        for n in axNodes(of: win, limit: 1200) {
            emit(["type": "node", "name": n.name, "role": n.role, "depth": n.depth, "parent": n.parent])
        }
    }
    exit(0)
}

while true {
    autoreleasepool {
        var roster: [String] = []
        var rosterSource: String? = nil
        var expected = 0
        var best: Candidate? = nil

        // Examine EVERY candidate window: a Meet tab and the Teams app can both be open, and the
        // old code returned after the first match, silently losing whichever came second.
        for (win, _, _) in candidateWindows() {
            let nodes = axNodes(of: win)
            if nodes.isEmpty { continue }
            // Not in a call → contribute nothing. Prevents an idle Slack/browser window from
            // poisoning the roster (and therefore knownNames) for the rest of the meeting.
            if !Heuristics.looksInCall(nodes) { continue }
            let found = Heuristics.findRoster(nodes)
            // A real participants panel outranks a tile-grid guess regardless of size, so an
            // ordinary browser window's incidental "list of capitalised words" cannot displace the
            // meeting's actual roster (and then poison knownNames for the rest of the call).
            let better = rosterSource != "participants-panel" || found.source == "participants-panel"
            if !found.names.isEmpty && found.names.count >= roster.count && better {
                roster = found.names
                rosterSource = found.source
                expected = Heuristics.expectedCount(nodes)
            }
            var pool = Set(found.names)
            pool.formUnion(knownNames)
            let active = Heuristics.findActiveByDecoration(nodes, pool: pool)
                ?? Heuristics.findActiveByPhrase(nodes, pool: pool)
            if let a = active, best == nil || a.confidence > best!.confidence { best = a }
        }

        knownNames.formUnion(roster)
        let ts = Int(Date().timeIntervalSince1970 * 1000)
        if let a = best, a.name != lastSpeaker {
            lastSpeaker = a.name
            emit(["ts": ts, "type": "active-speaker", "name": a.name,
                  "confidence": a.confidence, "strategy": a.strategy])
        }
        let key = roster.sorted().joined(separator: "|")
        if !roster.isEmpty && key != lastRosterKey {
            lastRosterKey = key
            emit(["ts": ts, "type": "roster", "names": roster,
                  "source": rosterSource ?? "unknown",
                  "confidence": rosterSource == "participants-panel" ? 0.9 : 0.75,
                  "expectedCount": expected])
        }
    }
    Thread.sleep(forTimeInterval: 0.5) // one sleep per poll (the old code slept twice: ~1s)
}
