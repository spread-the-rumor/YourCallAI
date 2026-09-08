// Roster normalization + merge (§7). Pure — no Electron, no IO — so test/selfcheck.js covers it.
//
// A "roster" here is the list of people believed to be IN this meeting. It is the closed set the
// AI name inference must choose from, so what gets in matters more than what gets out: a name
// that reaches the roster can be attached to a speaker, and a wrong one propagates into the
// summary, the action-item assignee, and the Slack/Asana send.

// Decorations the meeting UIs append to a participant label. Stripped before matching so
// "Priya Shah (Guest)", "Priya Shah, Host" and "Priya Shah" are one person.
const ROLE_WORDS = [
  'host', 'co-host', 'cohost', 'guest', 'organizer', 'organiser', 'presenter', 'attendee',
  'me', 'you', 'muted', 'unmuted', 'pinned', 'presenting', 'speaking', 'owner', 'moderator',
];
const ROLE_RE = new RegExp(`[,\\-–—]\\s*(${ROLE_WORDS.join('|')})\\b.*$`, 'i');
// A comma-separated field that reads as UI status rather than a person. Words drawn from real
// Teams/Meet/Zoom accessible labels — see the note in normalizeName().
const STATUS_CLAUSE_RE = /\b(has|is|are|was|available|control|context|menu|video|camera|mic|microphone|muted|unmuted|sharing|shared|speaking|presenting|pinned|spotlight|raised|hand|reaction|status|indicator|tools|myself|content|elapsed|encryption)\b/i;
// Emoji / status glyphs / pictographs, incl. variation selectors and ZWJ sequences.
const GLYPH_RE = /[‍️←-⇿⌀-➿⬀-⯿\u{1f000}-\u{1faff}]/gu;
// Lowercase particles that legitimately appear inside a surname.
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'da', 'di', 'du', 'la', 'le',
  'bin', 'ibn', 'al', 'el', 'ter', 'ten', 'op', 'st', 'mac', 'mc', "o'"]);
// Exact labels that are never a person but score like a short name, so personScore cannot reject
// them. "System" is the Win32 window menu, which appears as a MenuItem SIBLING of Teams' real
// participant rows (verified live). "Workspaces"/"Profile" etc. are browser chrome picked up when
// the agent scans a non-meeting window. Matched on the whole normalized string, never a substring,
// so a real "System" in someone's name (or a person actually called Nav) is unaffected.
const NON_PERSON_EXACT = new Set(['system', 'workspaces', 'workspace', 'profile', 'default',
  'guest', 'admin', 'administrator', 'untitled', 'new tab', 'home', 'general', 'unknown',
  'me', 'you', 'everyone', 'notifications', 'menu', 'toolbar', 'main', 'body', 'null']);

// Words that mean this string is a control, not a person.
const UI_WORDS = new Set(['turn', 'mute', 'unmute', 'join', 'leave', 'share', 'sharing', 'stop',
  'start', 'camera', 'video', 'audio', 'more', 'options', 'raise', 'hand', 'chat', 'people',
  'participants', 'reactions', 'settings', 'close', 'open', 'search', 'invite', 'add', 'copy',
  'record', 'recording', 'transcript', 'captions', 'present', 'screen', 'window', 'meeting',
  'call', 'everyone', 'waiting', 'room', 'breakout', 'pin', 'spotlight', 'remove', 'admit']);

// "Priya Shah (She/Her), Host  🎤" -> "Priya Shah"
function normalizeName(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(GLYPH_RE, ' ');
  s = s.replace(/\((?:[^()]*)\)/g, ' ');   // parenthesised pronouns / "(Guest)" / "(External)"
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(ROLE_RE, '');

  // Keep the first comma-separated field that looks like a name; drop status clauses.
  // Verified against a live Teams call, whose real roster label is:
  //   "Carlos Brito, Has control of production tools, Context menu is available"
  // ROLE_RE alone only stripped single role words, so those full clauses survived and every real
  // name scored 0.00. The dependable structure is: the name is a field, the rest is status.
  // Teams also prefixes its own tile ("Myself video, Sagar, …"), so a leading status field is
  // skipped rather than mistaken for the name.
  if (s.includes(',')) {
    const fields = s.split(',').map((f) => f.trim()).filter(Boolean);
    const named = fields.find((f) => !STATUS_CLAUSE_RE.test(f));
    s = named || fields[0] || s;
  }
  s = s.replace(/[\s ]+/g, ' ').trim();
  s = s.replace(/^[,;:\-–—.]+|[,;:\-–—]+$/g, '').trim();
  return s;
}

// Stable identity for a display name: case- and accent-insensitive, punctuation-free.
function nameKey(raw) {
  const n = normalizeName(raw).toLowerCase();
  return n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

const tokens = (raw) => nameKey(raw).split(' ').filter(Boolean);

// 0..1 — how much this string looks like a person's name rather than a UI control.
// A score, not a gate: the old boolean predicate rejected mononyms ("Sagar") and single-initial
// tokens ("J R Smith"), which are common for Meet guests.
function personScore(raw) {
  const n = normalizeName(raw);
  if (!n || n.length < 2 || n.length > 60) return 0;
  if (/\d/.test(n)) return 0;                       // "Room 4", "Speaker 2"
  if (/[@|•·<>/\\{}=+*#~^]|https?:/i.test(n)) return 0;
  const t = tokens(n);
  if (!t.length || t.length > 5) return 0;
  if (NON_PERSON_EXACT.has(nameKey(n))) return 0;
  if (t.some((w) => UI_WORDS.has(w))) return 0;
  if (t.every((w) => ROLE_WORDS.includes(w))) return 0;

  // Descriptive phrases that merely CONTAIN a name ("Content shared by Hernan Zapata",
  // "Myself video") are not roster rows. Seen live in Teams; a lowercase connective word is the
  // giveaway, since real names are capitalised throughout.
  if (/\b(shared|share|by|from|to|with|via|presented|pinned)\b/i.test(n)) return 0;

  let score = 0.5;
  // Capitalised tokens read as names; lowercase particles are fine inside one.
  const words = n.split(' ');
  const capped = words.filter((w, i) => /^[\p{Lu}]/u.test(w) || (i > 0 && PARTICLES.has(w.toLowerCase())));
  score += 0.35 * (capped.length / words.length);
  if (t.length >= 2) score += 0.15;                 // "Priya Shah" beats "Priya"
  return Math.min(1, score);
}

const isPersonName = (raw, threshold = 0.6) => personScore(raw) >= threshold;

// Match a loose candidate to a known roster entry. Tiers, most to least certain:
// exact key -> last name + first initial -> unique first name -> unique last name -> null.
// Returns { name, score } using the roster's canonical spelling, or null.
function matchToRoster(candidate, roster) {
  const names = (roster || []).map((r) => (typeof r === 'string' ? r : r && r.name)).filter(Boolean);
  if (!names.length) return null;
  const cKey = nameKey(candidate);
  if (!cKey) return null;

  for (const n of names) if (nameKey(n) === cKey) return { name: n, score: 1 };

  const c = tokens(candidate);
  if (!c.length) return null;
  const cFirst = c[0];
  const cLast = c[c.length - 1];

  // last name + first initial: "P. Shah" / "Priya S" -> "Priya Shah"
  const initialHits = names.filter((n) => {
    const t = tokens(n);
    if (t.length < 2 || c.length < 2) return false;
    return (t[t.length - 1] === cLast && t[0][0] === cFirst[0])
      || (t[0] === cFirst && t[t.length - 1][0] === cLast[0]);
  });
  if (initialHits.length === 1) return { name: initialHits[0], score: 0.85 };

  // Single-token candidate: accept only when it matches exactly one roster member.
  const firstHits = names.filter((n) => tokens(n)[0] === cFirst);
  if (firstHits.length === 1) return { name: firstHits[0], score: 0.7 };
  const lastHits = names.filter((n) => { const t = tokens(n); return t[t.length - 1] === cLast; });
  if (lastHits.length === 1) return { name: lastHits[0], score: 0.7 };

  return null; // ambiguous (two Priyas) — better unresolved than wrong
}

// Merge roster sources into one ranked, de-duplicated list.
// sources: [{ names: [...], source: 'participants-panel', confidence: 0.9, dictionary: false }]
// A `dictionary` source may only CANONICALISE a name another source already supplied — it can
// never introduce one. That is what keeps the whole Slack workspace (thousands of colleagues,
// from listSlackUsers) out of a 3-person meeting's roster.
function mergeRoster(sources) {
  const introducing = [];
  const dictionaries = [];
  for (const s of sources || []) {
    if (!s || !Array.isArray(s.names)) continue;
    (s.dictionary ? dictionaries : introducing).push(s);
  }

  const byKey = new Map();
  for (const s of introducing) {
    for (const raw of s.names) {
      const name = normalizeName(raw);
      if (!name || !isPersonName(name)) continue;
      const key = nameKey(name);
      if (!key) continue;
      const conf = typeof s.confidence === 'number' ? s.confidence : 0.5;
      const prev = byKey.get(key);
      if (!prev || conf > prev.confidence) {
        byKey.set(key, { name, source: s.source || 'unknown', confidence: conf });
      }
    }
  }

  // Canonicalise spellings against the dictionaries without adding entries.
  for (const dict of dictionaries) {
    for (const entry of byKey.values()) {
      const hit = matchToRoster(entry.name, dict.names);
      if (hit && hit.score >= 0.85 && nameKey(hit.name) === nameKey(entry.name)) entry.name = hit.name;
    }
  }

  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}

const rosterNames = (roster) => (roster || []).map((r) => (typeof r === 'string' ? r : r && r.name)).filter(Boolean);

// Is this roster safe to use as a CLOSED SET for AI inference?
//
// The closed set is a strong guard — it stops the model inventing names — but it cuts both ways:
// if the roster is junk, a correctly-inferred real name gets rejected and that speaker stays
// "Speaker N" forever. Measured on a live Google Meet: the agent returned
//   ["Back","Forward","Reload","Work","History Navigation","PDF Creator", …]
// (Chrome's toolbar and another tab's sidebar, every entry scoring 0.74–1.00, i.e. indistinguishable
// from a real name) and the actual participant was absent, so she was never resolved.
//
// The separator, measured on both real datasets vs the actual Meet pollution: human display names
// are overwhelmingly "First Last", i.e. EXACTLY two words. Scraped UI labels scatter across one
// word ("Back", "Work", "REPORTS") and three-plus ("Backgrounds and effects", "AI Topic Analysis").
//   real Meet roster   (2 people)  → 100% exactly-two-word
//   real Teams roster  (5 people)  →  60%
//   the Meet pollution (22 entries) →  32%
// A plain multi-word test does NOT separate them (55% vs 60%) — the *exactly two* constraint does.
// The word-count rule alone REJECTS legitimate rosters, measured:
//   ["Sagar","Vicky","Priya"]        (Meet guests, first names)  → 0% two-word → rejected
//   ["Sagar","Vicky Rana","iPhone"]  (Zoom, mixed + a device)     → 33%        → rejected
// Meet and Zoom guests routinely join under a single first name, so on those platforms the
// heuristic threw away a correct roster and fell back to unconstrained inference.
//
// It cannot be fixed by scoring names better. personScore() cannot separate them — measured,
// "Back" scores 0.85 exactly like "Sagar", and "History Navigation" scores 1.00 exactly like
// "Vicky Rana". Name shape carries no signal here.
//
// What DOES separate them is structural: a `participants-panel` source means the agent found a
// real accessible participants list inside a window that passed the in-call check. The captured
// pollution came from the tile-grid fallback in a browser window, never from a panel. So trust
// the structure when we have it, and fall back to the shape heuristic only when we don't.
const MIN_TWO_WORD_SHARE = 0.5;
const MAX_TRUSTWORTHY = 20; // a meeting this large is rare; a polluted scrape reaching it is not
const STRUCTURAL_SOURCES = new Set(['participants-panel']);

function rosterIsTrustworthy(roster) {
  const names = rosterNames(roster);
  if (!names.length) return false;
  if (names.length > MAX_TRUSTWORTHY) return false;

  // Structural evidence outranks name shape: a participants panel is a real roster even when
  // everyone in it goes by one name.
  const entries = (roster || []).filter((r) => r && typeof r === 'object');
  if (entries.length && entries.every((r) => STRUCTURAL_SOURCES.has(r.source))) return true;

  const twoWord = names.filter((n) => n.trim().split(/\s+/).length === 2).length;
  return twoWord >= 1 && twoWord / names.length >= MIN_TWO_WORD_SHARE;
}

module.exports = {
  normalizeName, nameKey, personScore, isPersonName, matchToRoster, mergeRoster, rosterNames,
  rosterIsTrustworthy,
};
