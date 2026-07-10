// Your Call AI — macOS active-speaker agent (§7 Layer 1).
// Reads meeting UIs via the AX API and emits one JSON line per observation to stdout.
// Requires the Accessibility permission (main app deep-links to System Settings).
// Known caveat: Chrome Guest/Incognito windows expose no AX tree — silently unavailable.
// All selector heuristics live in the Heuristics enum — fix UI breakage there.
import Foundation
import ApplicationServices
import AppKit

let heuristicsVersion = "2026-07-meet1-zoom1-teams1"
FileHandle.standardError.write("[agent] started, heuristics=\(heuristicsVersion)\n".data(using: .utf8)!)

var lastSpeaker: String? = nil
var lastRosterKey = ""

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        FileHandle.standardOutput.synchronizeFile()
    }
}

func axNames(of element: AXUIElement, limit: Int = 400) -> [String] {
    var results: [String] = []
    var stack: [AXUIElement] = [element]
    var visited = 0
    while let el = stack.popLast(), visited < limit {
        visited += 1
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success,
               let s = value as? String, s.count > 1, s.count < 120 {
                results.append(s)
            }
        }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
           let kids = children as? [AXUIElement] {
            stack.append(contentsOf: kids)
        }
    }
    return results
}

enum Heuristics {
    static let speaking = try! NSRegularExpression(pattern: "^(.{2,60}?),?\\s+is speaking\\b")
    static let plainName = try! NSRegularExpression(pattern: "^[\\p{L}][\\p{L}'.-]+( [\\p{L}][\\p{L}'.-]+){1,3}$")

    static func observe(names: [String]) -> (active: String?, roster: [String]) {
        var active: String? = nil
        var roster: [String] = []
        for n in names {
            let range = NSRange(n.startIndex..., in: n)
            if let m = speaking.firstMatch(in: n, range: range), active == nil,
               let r = Range(m.range(at: 1), in: n) {
                active = String(n[r]).trimmingCharacters(in: .whitespaces)
                continue
            }
            if plainName.firstMatch(in: n, range: range) != nil, n != "You" {
                roster.append(n)
            }
        }
        return (active, Array(Set(roster)).sorted().prefix(50).map { $0 })
    }
}

let meetingApps = ["Google Chrome", "Microsoft Edge", "zoom.us", "Microsoft Teams"]

func windowLooksLikeMeeting(_ title: String, app: String) -> Bool {
    if title.hasPrefix("Meet – ") || title.hasPrefix("Meet - ") { return true }
    if app == "zoom.us" && title.contains("Zoom Meeting") { return true }
    if title.contains("Microsoft Teams") && (title.contains("Meeting") || title.contains("Call")) { return true }
    return false
}

while true {
    autoreleasepool {
        for runningApp in NSWorkspace.shared.runningApplications {
            guard let name = runningApp.localizedName, meetingApps.contains(name) else { continue }
            let appEl = AXUIElementCreateApplication(runningApp.processIdentifier)
            var windowsRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &windowsRef) == .success,
                  let windows = windowsRef as? [AXUIElement] else { continue }
            for win in windows {
                var titleRef: CFTypeRef?
                AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleRef)
                let title = (titleRef as? String) ?? ""
                guard windowLooksLikeMeeting(title, app: name) else { continue }

                let (active, roster) = Heuristics.observe(names: axNames(of: win))
                let ts = Int(Date().timeIntervalSince1970 * 1000)
                if let a = active, a != lastSpeaker {
                    lastSpeaker = a
                    emit(["ts": ts, "type": "active-speaker", "name": a])
                }
                let key = roster.joined(separator: "|")
                if !roster.isEmpty && key != lastRosterKey {
                    lastRosterKey = key
                    emit(["ts": ts, "type": "roster", "names": roster])
                }
                Thread.sleep(forTimeInterval: 0.5)
                return
            }
        }
    }
    Thread.sleep(forTimeInterval: 0.5)
}
