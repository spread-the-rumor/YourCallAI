import './styles.css';
import logoUrl from './logo.png';

const api = window.api;
const $ = (id) => document.getElementById(id);

// ---------- shared transcript extraction (§4.1 — mirrors src/transcriptUtils.js) ----------
const segSpeaker = (s) => s.speaker || s.participant?.name || 'Speaker';
const segText = (s) => (Array.isArray(s.words) ? s.words.map((w) => w.text).join(' ') : (s.text || ''));

const state = {
  meetings: [],
  trash: [],
  currentId: null,
  view: 'summary',
  dest: 'slack',
  search: '',
  searchIds: null,    // Set of ids matching `search` (computed in main), null = no query
  liveSummary: {},    // recordingId -> summary text streamed so far
  chatStream: null,   // { id, el, text } while a chat reply streams in
  range: 'all',       // all | week | month (date filter next to search)
  flags: {},
  status: { state: 'idle', detail: '', recording: false },
  slackTargets: null,     // { channels, users } cache
  overviewProjects: null, // cache
  asanaConnected: false,
  asanaWorkspaces: null,  // cache
  asanaWorkspaceGid: null, // current workspace selection
  asanaProjects: null,    // cache for the selected workspace
  asanaUsers: null,       // cache for the selected workspace (assignee dropdown)
};

const current = () => state.meetings.find((m) => m.id === state.currentId) || null;

// ---------- formatting ----------
function relDate(iso) {
  const d = new Date(iso), now = new Date();
  // Calendar days in local time, not 24 h periods: 11 pm yesterday viewed at 8 am is "Yesterday".
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400_000); // round absorbs DST hours
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
function fmtDuration(transcript) {
  if (!transcript?.length) return '';
  const last = transcript[transcript.length - 1];
  const w = last.words?.[last.words.length - 1];
  const secs = w?.end_timestamp?.relative || last.end || 0;
  const m = Math.round(secs / 60);
  return m >= 1 ? `${m} min` : `${Math.round(secs)}s`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- status pill + record buttons ----------
// `recording` is main's authoritative flag (independent of `state`, which may describe work on
// another meeting). Older payloads without it fall back to the state string.
const isRecording = () => (typeof state.status.recording === 'boolean'
  ? state.status.recording
  : state.status.state === 'recording');
let recordBusy = false; // a start/stop IPC is in flight; buttons stay disabled until it settles

function renderStatus() {
  const pill = $('status-pill'), text = $('status-text');
  const { state: st, detail } = state.status;
  const rec = isRecording();
  pill.className = 'status-pill';
  const labels = {
    idle: state.flags.deepgram ? 'Idle' : 'Idle — add Deepgram key in Settings',
    'meeting-detected': 'Meeting detected',
    recording: detail || 'Recording',
    processing: detail || 'Processing…',
    transcribing: detail || 'Transcribing…',
    error: detail || 'Error',
  };
  // A recording can be live while main reports progress for ANOTHER meeting (transcribing the
  // previous one, normalizing video). The pill shows that progress, but keeps the recording dot
  // and the Stop button — hiding Stop mid-meeting left the user no way to end the recording.
  let label = labels[st] || st;
  if (rec && st !== 'recording') label = `Recording · ${label}`;
  text.textContent = label;
  if (rec || st === 'recording') pill.classList.add('recording');
  else if (st === 'meeting-detected') pill.classList.add('detected');
  else if (st === 'processing' || st === 'transcribing') pill.classList.add('busy');
  else if (st === 'error') pill.classList.add('error');

  const recBtn = $('btn-record'), huddleBtn = $('btn-huddle');
  recBtn.disabled = huddleBtn.disabled = recordBusy; // a start/stop call is in flight
  // While recording there is exactly ONE stop control (#btn-record). Huddle is a *start* path
  // only; a second stop button beside it just made users guess which one ends the meeting.
  if (rec) {
    recBtn.classList.remove('hidden');
    recBtn.classList.add('stop');
    recBtn.textContent = '■ Stop Recording';
    huddleBtn.classList.add('hidden');
  } else {
    huddleBtn.classList.remove('hidden', 'stop');
    huddleBtn.textContent = '🎙 Huddle';
    recBtn.classList.remove('stop');
    recBtn.textContent = '● Start Recording';
    recBtn.classList.toggle('hidden', st !== 'meeting-detected');
  }
}

// ---------- sidebar list ----------
// Search runs in main, which holds the transcripts; the list here carries none. state.searchIds
// is the matching id set for state.search, or null when there is no query.
function matches(m) {
  return !state.searchIds || state.searchIds.has(m.id);
}
let searchSeq = 0;
async function refreshSearch() {
  const q = state.search.trim();
  // Bump BEFORE the empty-query return: clearing the box must also cancel an in-flight query,
  // or its late answer would re-apply a filter to a list the user just cleared.
  const seq = ++searchSeq;
  if (!q) { state.searchIds = null; return; }
  const ids = await api.searchMeetings(q);
  if (seq === searchSeq) state.searchIds = new Set(ids || []); // drop answers to superseded queries
}

// Date-range filter: this week = last 7 days, this month = current calendar month.
function inRange(m, range) {
  if (range === 'all') return true;
  const d = new Date(m.date), now = new Date();
  if (range === 'week') return now - d < 7 * 86400_000;
  if (range === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  return true;
}
const monthKey = (iso) => new Date(iso).toLocaleDateString([], { month: 'long', year: 'numeric' });

function mkMeetingItem(m) {
  const el = document.createElement('div');
  el.className = 'meeting-item' + (m.id === state.currentId ? ' active' : '');
  el.innerHTML = `<div class="m-title">${esc(m.title)}</div><div class="m-date">${relDate(m.date)}</div>
    <button class="m-del" title="Move to trash">🗑</button>`;
  el.addEventListener('click', () => selectMeeting(m.id));
  el.querySelector('.m-del').addEventListener('click', async (e) => {
    e.stopPropagation();
    discardSave(m.id);
    await api.deleteMeeting(m.id);
    await reload(m.id === state.currentId ? { clearCurrent: true } : {});
  });
  return el;
}

function renderList() {
  const list = $('meeting-list');
  list.innerHTML = '';
  const shown = state.meetings.filter((m) => matches(m) && inRange(m, state.range));

  // Group by month; each month is an expandable section, open if it holds the active meeting.
  const groups = new Map();
  for (const m of shown) {
    const k = monthKey(m.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const [label, meetings] of groups) {
    const sec = document.createElement('details');
    sec.className = 'month-group';
    sec.open = meetings.some((m) => m.id === state.currentId) || groups.size === 1;
    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="month-name">${esc(label)}</span><span class="month-count">${meetings.length}</span>`;
    sec.appendChild(sum);
    for (const m of meetings) sec.appendChild(mkMeetingItem(m));
    list.appendChild(sec);
  }
  if (!shown.length) list.innerHTML = '<p class="muted empty-list">No meetings match.</p>';

  $('trash-count').textContent = state.trash.length || '';
  const tl = $('trash-list');
  tl.innerHTML = '';
  for (const m of state.trash) {
    const el = document.createElement('div');
    el.className = 'trash-item';
    el.innerHTML = `<span class="t-title">${esc(m.title)}</span>
      <button title="Restore">↩</button><button title="Delete forever">✕</button>`;
    const [restoreBtn, delBtn] = el.querySelectorAll('button');
    restoreBtn.addEventListener('click', async () => { await api.restoreMeeting(m.id); await reload(); });
    delBtn.addEventListener('click', async () => {
      if (confirm(`Delete "${m.title}" forever? This also deletes its recording files.`)) {
        await api.deleteMeetingPermanent(m.id);
        await reload();
      }
    });
    tl.appendChild(el);
  }
}

// ---------- editor ----------
// List items are "light" (no transcript/chat). The open meeting is fetched in full.
async function ensureFull(id) {
  const m = state.meetings.find((x) => x.id === id);
  if (!m || !m._light) return;
  const full = await api.getMeeting(id);
  if (full) patchLocal(full);
}

// opts.keepPanels: leave Settings / the chat modal as they are (an automatic selection must not
// close something the user is looking at).
async function selectMeeting(id, { keepPanels = false } = {}) {
  flushSave(); // the pending edit belongs to the meeting being left; it carries its own id
  state.currentId = id;
  state.view = 'summary';
  if (!keepPanels) { closeSettings(); closeChat(); }
  renderList();
  renderEditor(); // title + notes show immediately from the light item
  await ensureFull(id);
  if (state.currentId === id) { renderEditor(); rerenderChatIfOpen(); }
}

// Placeholder text the pipeline writes before the summary exists (main.js buildPlaceholderMeeting).
const isPlaceholderSummary = (s) => !s || s.startsWith('Recording saved.');

function renderEditor() {
  const m = current();
  $('empty-state').classList.toggle('hidden', !!m);
  $('editor').classList.toggle('hidden', !m);
  updateFab();
  if (!m) { state.editorId = null; return; }

  // Re-renders happen at arbitrary times (meeting-updated, sync, flags). Never overwrite a field
  // the user is typing in or has an unsaved edit for — unless a different meeting is now shown.
  const sameMeeting = state.editorId === m.id;
  state.editorId = m.id;
  const keepField = (el, field) => sameMeeting && !el.readOnly
    && (document.activeElement === el || hasPendingEdit(m.id, field));

  if (!keepField($('note-title'), 'title')) $('note-title').value = m.title;
  const participants = m.participants || [...new Set((m.transcript || []).map(segSpeaker))];
  const parts = [
    new Date(m.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
    m.transcript ? fmtDuration(m.transcript) : fmtSeconds(m.durationSec),
    participants.length ? participants.join(', ') : null,
  ].filter(Boolean);
  $('meta-line').textContent = parts.join('  ·  ');
  renderCaptureWarning(m);

  document.querySelectorAll('.view-toggle .seg-toggle').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  $('view-summary').classList.toggle('hidden', state.view !== 'summary');
  $('view-transcript').classList.toggle('hidden', state.view !== 'transcript');

  if (state.view === 'summary') {
    // While the summary is still being generated, show it as it streams in (read-only, so the
    // final text can't overwrite something the user typed into a half-finished summary).
    const live = state.liveSummary[m.id];
    const showLive = !!live && isPlaceholderSummary(m.content);
    const notes = $('note-content');
    if (!keepField(notes, 'content')) {
      notes.value = showLive ? live : (m.content || '');
      notes.readOnly = showLive;
    }
    renderActionRow(m);
    renderSendBlock(m);
  }
  if (state.view === 'transcript') {
    if (m._light && m.hasTranscript) $('view-transcript').innerHTML = '<p class="muted">Loading transcript…</p>';
    else renderTranscript(m);
  }
}
function fmtSeconds(secs) {
  if (!secs) return '';
  const m = Math.round(secs / 60);
  return m >= 1 ? `${m} min` : `${Math.round(secs)}s`;
}

// The app has always MEASURED truncation (normalize.js compares output length against the
// wall-clock span) and always kept it to itself: a 48-minute meeting that captured 2.5 minutes
// was presented exactly like a healthy one. Detection the user never sees is not a feature.
function renderCaptureWarning(m) {
  const el = $('capture-warn');
  const c = m.capture;
  if (!c || !c.partial) { el.classList.add('hidden'); el.textContent = ''; return; }
  const mins = (ms) => Math.max(1, Math.round(ms / 60000));
  const pct = c.expectedMs ? Math.round((c.capturedMs / c.expectedMs) * 100) : null;
  el.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = '⚠ Incomplete recording — ';
  el.appendChild(b);
  el.appendChild(document.createTextNode(
    `captured about ${mins(c.capturedMs)} min of a ${mins(c.expectedMs)} min meeting`
    + (pct != null ? ` (${pct}%)` : '')
    + '. Audio capture stopped early, so the transcript and summary cover only that part.'));
  el.classList.remove('hidden');
}

// After Open/Download main may have converted the recording (new videoUrl, capture.partial).
// Patch just that data — a full reload()/renderEditor would rebuild the action row and wipe the
// result message the user is reading on the button.
async function refreshMediaState(id) {
  try {
    const full = await api.getMeeting(id);
    if (!full) return;
    patchLocal(full);
    if (state.currentId === id) renderCaptureWarning(current());
  } catch (err) { console.error('refresh after media action failed', err); }
}

function summaryFailed(m) {
  return !m.content?.trim() || m.content.startsWith('Summary unavailable');
}

function renderActionRow(m) {
  const row = $('action-row');
  row.innerHTML = '';
  const add = (label, fn, opts = {}) => {
    const b = document.createElement('button');
    b.className = 'btn small' + (opts.primary ? ' primary' : '');
    b.textContent = label;
    b.addEventListener('click', () => fn(b));
    row.appendChild(b);
    return b;
  };
  if (m.videoUrl) {
    // Both go through main, which converts the recording to MP4 first if it has not been
    // converted yet — instant once it has. The status pill carries the percentage during a
    // conversion; these just show that something is happening.
    add('▶ Open in player', async (b) => {
      b.disabled = true; b.textContent = 'Opening…';
      let r;
      try { r = await api.openRecording(m.id); } catch (err) { r = { ok: false, error: err?.message }; }
      b.disabled = false;
      b.textContent = r && !r.ok ? `⚠ ${(r.error || 'Could not open').slice(0, 48)}` : '▶ Open in player';
      if (r && !r.ok) setTimeout(() => { b.textContent = '▶ Open in player'; }, 4000);
      refreshMediaState(m.id);
    });
    add('⬇ Download', async (b) => {
      b.disabled = true; b.textContent = 'Saving…';
      let r;
      try { r = await api.saveRecording(m.id); } catch (err) { r = { ok: false, error: err?.message }; }
      b.disabled = false;
      b.textContent = r.ok ? '✓ Saved' : (r.canceled ? '⬇ Download' : `⚠ ${(r.error || 'Failed').slice(0, 48)}`);
      setTimeout(() => { b.textContent = '⬇ Download'; }, r.ok ? 2500 : 4000);
      refreshMediaState(m.id);
    });
  }
  if (m.transcript?.length || m.hasTranscript) {
    const exportAs = (fmt, label) => add(label, async (b) => {
      let r;
      try { r = await api.saveTranscript(m.id, fmt); } catch (err) { r = { ok: false, error: err?.message }; }
      if (r && r.ok === false && !r.canceled) {
        b.textContent = `⚠ ${(r.error || 'Failed').slice(0, 48)}`;
        setTimeout(() => { b.textContent = label; }, 4000);
      }
    });
    exportAs('txt', 'Export .txt');
    exportAs('json', 'Export .json');
  } else {
    add('↻ Retry transcription', async (b) => {
      b.disabled = true; b.textContent = 'Retrying…';
      let r;
      try { r = await api.retryTranscription(m.id); } catch (err) { r = { ok: false, error: err?.message }; }
      // { ok: true } → the pipeline runs and recording-complete re-renders this meeting later.
      if (r && r.ok === false) {
        b.disabled = false;
        b.textContent = `⚠ ${(r.error || 'Could not retry').slice(0, 60)}`;
        b.title = r.error || '';
        setTimeout(() => { if (b.isConnected) b.textContent = '↻ Retry transcription'; }, 5000);
      }
    }, { primary: true });
  }
  if ((m.transcript?.length || m.hasTranscript) && m.recordingId) {
    add('↻ Re-resolve names', async (b) => {
      b.disabled = true; b.textContent = 'Resolving names…';
      const r = await api.reresolveNames(m.id);
      if (r.ok) { patchLocal(r.meeting); renderEditor(); return; }
      b.disabled = false; b.textContent = `⚠ ${(r.error || 'Failed').slice(0, 60)}`;
    });
  }
  if ((m.transcript?.length || m.hasTranscript) && summaryFailed(m)) {
    add('↻ Regenerate summary', async (b) => {
      b.disabled = true; b.textContent = 'Regenerating…';
      const r = await api.regenerateSummary(m.id);
      if (r.ok) { patchLocal(r.meeting); renderEditor(); }
      else { b.disabled = false; b.textContent = `⚠ ${r.error?.slice(0, 60) || 'Failed'}`; }
    }, { primary: true });
  }
}

// How each speaker name was arrived at, for the unverified tooltip (§7).
const SOURCE_LABELS = {
  'native-agent': 'the meeting window',
  history: 'who usually leads this recurring meeting',
  'ai-inference': 'the conversation',
  'prior-manual-stale': 'an earlier rename that may no longer match this speaker',
  'signed-in-user': 'your account',
  manual: 'your rename',
};

// ---------- transcript view + rename (§7 Layer 3) ----------
function renderTranscript(m) {
  const box = $('view-transcript');
  box.innerHTML = '';
  if (!m.transcript?.length) {
    box.innerHTML = '<p class="muted">No transcript for this meeting.</p>';
    return;
  }
  // A name the app is not sure about is worse than a missing one: it flows into the summary, the
  // action-item assignee and the Slack/Asana send. Mark it instead, so a wrong name costs one click.
  const speakerMap = m.speakerMap || {};
  const attribution = (seg) => {
    const raw = speakerMap[`${seg.channel}:${seg.diarizedSpeaker}`];
    if (!raw) return null;
    return typeof raw === 'string' ? { name: raw, confidence: 1, source: 'manual' } : raw;
  };
  const unresolved = m.nameAttribution?.unresolved || [];
  if (unresolved.length) {
    const note = document.createElement('p');
    note.className = 'muted transcript-note';
    note.textContent = unresolved.length === 1
      ? 'One speaker could not be identified — click the name to correct it.'
      : `${unresolved.length} speakers could not be identified — click a name to correct it.`;
    box.appendChild(note);
  }

  for (const seg of m.transcript) {
    const el = document.createElement('div');
    el.className = 'seg';
    const nameEl = document.createElement('div');
    const info = attribution(seg);
    const unverified = !!info && typeof info.confidence === 'number' && info.confidence < 0.85;
    nameEl.className = 'speaker' + (seg.channel === 0 ? ' you' : '') + (unverified ? ' unverified' : '');
    nameEl.textContent = segSpeaker(seg) + (unverified ? ' ?' : '');
    // Renaming is keyed by channel:diarizedSpeaker. A segment without both (older or synced
    // transcripts) would rename an "undefined:undefined" speaker, so it is not offered.
    const renamable = seg.channel !== 0
      && Number.isFinite(seg.channel) && Number.isFinite(seg.diarizedSpeaker);
    if (renamable) {
      nameEl.title = unverified
        ? `Unverified — inferred from ${SOURCE_LABELS[info.source] || info.source}. Click to correct.`
        : 'Click to rename this speaker';
      nameEl.addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = segSpeaker(seg);
        nameEl.replaceWith(input);
        input.focus(); input.select();
        // Enter then blur (the re-render removes the focused input) used to rename twice, and
        // Escape followed by the blur it causes renamed anyway. Exactly one outcome per edit.
        let done = false;
        const rerender = () => { const cur = current(); if (cur && cur.id === m.id) renderTranscript(cur); };
        const commit = async () => {
          if (done) return;
          done = true;
          const v = input.value.trim();
          if (v && v !== segSpeaker(seg)) {
            input.disabled = true;
            let r;
            try { r = await api.renameSpeaker(m.id, seg.channel, seg.diarizedSpeaker, v); }
            catch (err) { r = { ok: false, error: err?.message }; }
            if (r?.ok && r.meeting) { patchLocal(r.meeting); if (state.currentId === m.id) renderEditor(); return; }
            if (!r?.ok) {
              rerender();
              const note = document.createElement('p');
              note.className = 'send-status err transcript-note';
              note.textContent = `⚠ Rename failed: ${(r && r.error) || 'unknown error'}`;
              if (state.currentId === m.id && state.view === 'transcript') $('view-transcript').prepend(note);
              return;
            }
            // ok without a meeting payload: re-read it so the new name shows.
            const full = await api.getMeeting(m.id).catch(() => null);
            if (full) patchLocal(full);
            if (state.currentId === m.id) renderEditor();
            return;
          }
          rerender();
        };
        const cancel = () => { if (done) return; done = true; rerender(); };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        });
        input.addEventListener('blur', commit);
      });
    }
    const textEl = document.createElement('div');
    textEl.className = 'text';
    textEl.textContent = segText(seg);
    el.append(nameEl, textEl);
    box.appendChild(el);
  }
}

// ---------- chat (floating modal) ----------
async function openChat() {
  const m = current();
  if (!m) return;
  $('chat-modal').classList.remove('hidden');
  $('chat-fab').classList.add('open');
  renderChat(m); // a light item shows "Loading…" until the full meeting (with chat) arrives
  $('chat-input').focus();
  if (m._light) {
    await ensureFull(m.id);
    if (state.currentId === m.id) rerenderChatIfOpen();
  }
}
function closeChat() {
  $('chat-modal').classList.add('hidden');
  $('chat-fab').classList.remove('open');
}
function updateFab() {
  // Bubble only makes sense with a meeting open and settings closed.
  const settingsOpen = !$('settings-view').classList.contains('hidden');
  $('chat-fab').classList.toggle('hidden', !current() || settingsOpen);
}

// Turns shown for this session only and never saved into m.chat: the question in flight and a
// failed question + its error. Keyed by meeting id.
const chatTemp = {};
let chatBusy = false;

function setChatBusy(busy) {
  chatBusy = busy;
  $('chat-input').disabled = busy;
  $('chat-send').disabled = busy;
}

function renderChat(m) {
  const thread = $('chat-thread');
  thread.innerHTML = '';
  const add = (role, content, extra = '') => {
    const b = document.createElement('div');
    b.className = `bubble ${role}${extra}`;
    b.textContent = content;
    thread.appendChild(b);
  };
  if (m._light && !m.chat) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Loading conversation…';
    thread.appendChild(p);
  }
  for (const t of m.chat || []) add(t.role, t.content);
  for (const t of chatTemp[m.id] || []) add(t.role, t.content, t.error ? ' error' : (t.unsent ? ' unsent' : ''));
  // The streaming bubble is a live element the chat-delta handler writes into: re-attach it.
  if (state.chatStream && state.chatStream.id === m.id) thread.appendChild(state.chatStream.el);
  thread.scrollTop = thread.scrollHeight;
}

async function sendChat() {
  if (chatBusy) return; // one question at a time; Enter while waiting is ignored
  const m = current();
  const input = $('chat-input');
  const q = input.value.trim();
  if (!m || !q) return;
  input.value = '';
  setChatBusy(true);
  // The question is shown immediately but NOT added to m.chat: main stores the user + assistant
  // turns only when the answer succeeds, so a failure must not leave a half-turn behind.
  const userTurn = { role: 'user', content: q, unsent: true };
  const temp = (chatTemp[m.id] = [userTurn]); // an earlier failed attempt is superseded
  const thinking = document.createElement('div');
  thinking.className = 'bubble assistant thinking';
  thinking.textContent = 'Thinking…';
  // Streamed reply: 'chat-delta' events fill this bubble while the request is in flight.
  const stream = { id: m.id, el: thinking, text: '' };
  state.chatStream = stream;
  renderChat(m);

  let r;
  try {
    r = await api.askMeeting(m.id, q);
  } catch (err) {
    r = { ok: false, error: err?.message || 'Request failed' };
  } finally {
    if (state.chatStream === stream) state.chatStream = null;
    setChatBusy(false);
  }
  // Older main builds answered { answer } without `ok`.
  const ok = !!r && (r.ok === true || (r.ok === undefined && typeof r.answer === 'string'));
  if (ok) {
    delete chatTemp[m.id];
    // m may have been replaced in state.meetings (ensureFull / meeting-updated) while waiting.
    const target = state.meetings.find((x) => x.id === m.id) || m;
    const chat = target.chat || [];
    const n = chat.length;
    const alreadyThere = n >= 2 && chat[n - 2].content === q && chat[n - 1].content === r.answer;
    if (!alreadyThere) target.chat = [...chat, { role: 'user', content: q }, { role: 'assistant', content: r.answer }];
  } else {
    temp.push({ role: 'assistant', content: `⚠ ${(r && r.error) || 'Could not get an answer.'}`, error: true });
  }
  if (state.currentId === m.id && chatIsOpen()) {
    renderChat(current());
    input.focus();
  }
}

// ---------- send-to block ----------
// dest key -> panel renderer. Keys must match both the #send-<key> element ids and the
// data-dest values on the toggle buttons, so adding a destination is a one-line change here.
const SEND_PANELS = {
  slack: renderSlackPanel,
  getoverview: renderOverviewPanel,
  asana: renderAsanaPanel,
};

function renderSendBlock(m) {
  document.querySelectorAll('.send-toggle .seg-toggle').forEach((b) =>
    b.classList.toggle('active', b.dataset.dest === state.dest));
  for (const key of Object.keys(SEND_PANELS)) {
    $(`send-${key}`).classList.toggle('hidden', state.dest !== key);
  }
  (SEND_PANELS[state.dest] || renderSlackPanel)(m);
}

// Panels load lists over IPC and can resolve after the user opened another meeting or switched
// destination (or a newer render of the same panel started). Each render takes a token; after
// every await it checks the token is still the latest AND the meeting is still the open one.
const panelSeq = {};
function panelToken(key, m) {
  const seq = (panelSeq[key] = (panelSeq[key] || 0) + 1);
  return () => panelSeq[key] === seq && current()?.id === m.id;
}
// The open meeting's CURRENT state at send time (the closure's `m` may be a replaced object
// with an old title). Null if the meeting is no longer open.
function liveMeeting(m) {
  const cur = current();
  return cur && cur.id === m.id ? cur : null;
}

function statusEl(cls = '') {
  const s = document.createElement('span');
  s.className = `send-status ${cls}`;
  return s;
}

async function renderSlackPanel(m) {
  const panel = $('send-slack');
  if (!state.flags.slack) {
    panel.innerHTML = '<span class="muted">Slack is not available.</span>';
    return;
  }
  if (!state.slackConnected) {
    panel.innerHTML = '<span class="muted">Connect your Slack workspace in Settings to send here.</span>';
    return;
  }
  const live = panelToken('slack', m);
  panel.innerHTML = '<span class="muted">Loading Slack channels…</span>';
  if (!state.slackTargets) {
    let ch, us;
    try {
      // Serial, not parallel: two Tier-2 methods fired together trip Slack's rate limit. slack.js caches each.
      ch = await api.listSlackChannels();
      us = await api.listSlackUsers();
    } catch (err) {
      if (live()) panel.innerHTML = `<span class="send-status err">${esc(err.message || 'Slack request failed')}</span>`;
      return;
    }
    if (!ch.ok) { if (live()) panel.innerHTML = `<span class="send-status err">${esc(ch.error)}</span>`; return; }
    state.slackTargets = { channels: ch.channels || [], users: us?.ok ? us.users : [] };
  }
  if (!live()) return; // a newer render (or another meeting) owns the panel now
  panel.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'send-row';
  const sel = document.createElement('select');
  const gCh = document.createElement('optgroup'); gCh.label = 'Channels';
  for (const c of state.slackTargets.channels)
    gCh.append(new Option(c.isExternal ? `#${c.name} (external)` : `#${c.name}`, `channel:${c.id}`));
  const gUs = document.createElement('optgroup'); gUs.label = 'People';
  const gEx = document.createElement('optgroup'); gEx.label = 'External people';
  for (const u of state.slackTargets.users) (u.isExternal ? gEx : gUs).append(new Option(u.name, `user:${u.id}`));
  sel.append(gCh, gUs);
  if (gEx.childElementCount) sel.append(gEx);
  const btn = document.createElement('button');
  btn.className = 'slack-btn';
  btn.innerHTML = `${SLACK_LOGO_SVG}<span>Send in Slack</span>`;
  const st = statusEl();
  btn.addEventListener('click', async () => {
    const cur = liveMeeting(m);
    if (!cur) return;
    const [type, id] = sel.value.split(':');
    btn.disabled = true; st.textContent = 'Sending…'; st.className = 'send-status';
    // Send the EDITED note text (title as typed right now); no localhost video links.
    const text = `*${$('note-title').value || cur.title}*\n\n${$('note-content').value}`;
    let r;
    try { r = await api.sendToSlack({ type, id }, text); } catch (err) { r = { ok: false, error: err?.message || 'Send failed' }; }
    btn.disabled = false;
    st.className = `send-status ${r.ok ? 'ok' : 'err'}`;
    st.textContent = r.ok ? '✓ Sent' : `⚠ ${r.error}`;
  });
  row.append(sel, btn, st);
  panel.appendChild(row);
}

// Official Slack mark (4-colour), sized to the button via CSS.
const SLACK_LOGO_SVG = `<svg viewBox="0 0 122.8 122.8" width="16" height="16" aria-hidden="true">
<path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#e01e5a"/>
<path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36c5f0"/>
<path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2eb67d"/>
<path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ecb22e"/>
</svg>`;

async function renderOverviewPanel(m) {
  const panel = $('send-getoverview');
  if (!state.flags.getoverview) {
    panel.innerHTML = '<span class="muted">GetOverview is not available.</span>';
    return;
  }
  const live = panelToken('getoverview', m);
  panel.innerHTML = '<span class="muted">Loading projects…</span>';
  if (!state.overviewProjects) {
    const r = await api.listGetOverviewProjects();
    if (!r.ok) { if (live()) panel.innerHTML = `<span class="send-status err">${esc(r.error)}</span>`; return; }
    state.overviewProjects = r.projects || [];
  }
  if (!live()) return;
  panel.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'send-row';
  const sel = document.createElement('select');
  const byStatus = {};
  for (const p of state.overviewProjects) (byStatus[p.status] ||= []).push(p);
  for (const [status, projects] of Object.entries(byStatus)) {
    const g = document.createElement('optgroup'); g.label = status;
    for (const p of projects) g.append(new Option(p.name, p.id));
    sel.appendChild(g);
  }
  const refresh = document.createElement('button');
  refresh.className = 'btn small'; refresh.textContent = '↻'; refresh.title = 'Refresh projects';
  refresh.addEventListener('click', () => {
    const cur = liveMeeting(m);
    if (!cur) return;
    state.overviewProjects = null;
    renderOverviewPanel(cur);
  });
  const openLink = document.createElement('button');
  openLink.className = 'btn small ghost'; openLink.textContent = 'Open in GetOverview ↗';
  openLink.addEventListener('click', () => {
    const p = state.overviewProjects.find((x) => String(x.id) === sel.value);
    if (p?.url) window.open(p.url, '_blank');
  });
  row.append(sel, refresh, openLink);
  panel.appendChild(row);

  const sendRow = document.createElement('div');
  sendRow.className = 'send-row';
  const st = statusEl();
  const mkSend = (label, kind) => {
    const b = document.createElement('button');
    b.className = 'btn small primary'; b.textContent = label;
    b.addEventListener('click', async () => {
      if (!liveMeeting(m)) return;
      b.disabled = true; st.textContent = 'Sending…'; st.className = 'send-status';
      // Main reads title/summary from the store: push a pending edit first so it sends what is shown.
      await flushSave();
      let r;
      try { r = await api.sendGetOverviewTranscript(sel.value, m.id, kind); } catch (err) { r = { ok: false, error: err?.message || 'Send failed' }; }
      b.disabled = false;
      st.className = `send-status ${r.ok ? 'ok' : 'err'}`;
      st.textContent = r.ok ? `✓ Submitted (job ${r.jobId || 'queued'})` : `⚠ ${r.error}`;
    });
    return b;
  };
  const extractBtn = document.createElement('button');
  extractBtn.className = 'btn small'; extractBtn.textContent = '⚡ Create tasks from action items';
  sendRow.append(mkSend('Send summary', 'summary'), mkSend('Send full transcript', 'transcript'), extractBtn, st);
  panel.appendChild(sendRow);

  const aiBox = document.createElement('div');
  aiBox.className = 'ai-rows';
  panel.appendChild(aiBox);
  wireActionItems(extractBtn, aiBox, m, sel, st);
}

// Asana is task-creation only — no summary/transcript export. Workspace → project → tasks.
async function renderAsanaPanel(m) {
  const panel = $('send-asana');
  if (!state.flags.asana) {
    panel.innerHTML = '<span class="muted">Asana is not available.</span>';
    return;
  }
  if (!state.asanaConnected) {
    panel.innerHTML = '<span class="muted">Connect your Asana account in Settings to create tasks here.</span>';
    return;
  }
  const live = panelToken('asana', m);
  const fail = (msg) => { if (live()) panel.innerHTML = `<span class="send-status err">${esc(msg)}</span>`; };
  panel.innerHTML = '<span class="muted">Loading Asana workspaces…</span>';

  if (!state.asanaWorkspaces) {
    const r = await api.listAsanaWorkspaces();
    if (!r.ok) { fail(r.error); return; }
    state.asanaWorkspaces = r.workspaces || [];
  }
  if (!live()) return;
  if (!state.asanaWorkspaces.length) {
    panel.innerHTML = '<span class="muted">No Asana workspaces found for this account.</span>';
    return;
  }
  // Default to the first workspace; keep the user's choice across re-renders.
  if (!state.asanaWorkspaces.some((w) => w.gid === state.asanaWorkspaceGid)) {
    state.asanaWorkspaceGid = state.asanaWorkspaces[0].gid;
  }

  const wsGid = state.asanaWorkspaceGid;
  if (!state.asanaProjects) {
    const r = await api.listAsanaProjects(wsGid);
    if (!live()) return; // superseded; a workspace switch must not get this one's projects
    if (!r.ok) { fail(r.error); return; }
    state.asanaProjects = r.projects || [];
  }
  // Assignee list is best-effort: a failure just means the dropdowns show Unassigned only.
  if (!state.asanaUsers) {
    const r = await api.listAsanaUsers(wsGid);
    if (!live()) return;
    state.asanaUsers = r.ok ? (r.users || []) : [];
  }
  if (!live()) return;
  panel.innerHTML = '';

  // Row 1 — workspace. Changing it invalidates the project + user caches.
  const wsRow = document.createElement('div');
  wsRow.className = 'send-row';
  const wsSel = document.createElement('select');
  for (const w of state.asanaWorkspaces) wsSel.append(new Option(w.name, w.gid));
  wsSel.value = state.asanaWorkspaceGid;
  wsSel.addEventListener('change', () => {
    state.asanaWorkspaceGid = wsSel.value;
    state.asanaProjects = null;
    state.asanaUsers = null;
    const cur = liveMeeting(m);
    if (cur) renderAsanaPanel(cur);
  });
  const wsLabel = document.createElement('span');
  wsLabel.className = 'muted';
  wsLabel.textContent = 'Workspace';
  wsRow.append(wsLabel, wsSel);
  panel.appendChild(wsRow);

  // Row 2 — project, grouped by team.
  const projRow = document.createElement('div');
  projRow.className = 'send-row';
  const sel = document.createElement('select');
  if (!state.asanaProjects.length) {
    sel.append(new Option('No projects in this workspace', ''));
    sel.disabled = true;
  } else {
    const byTeam = {};
    for (const p of state.asanaProjects) (byTeam[p.team] ||= []).push(p);
    for (const [team, projects] of Object.entries(byTeam)) {
      const g = document.createElement('optgroup'); g.label = team;
      for (const p of projects) g.append(new Option(p.name, p.id));
      sel.appendChild(g);
    }
  }
  const refresh = document.createElement('button');
  refresh.className = 'btn small'; refresh.textContent = '↻'; refresh.title = 'Refresh projects';
  refresh.addEventListener('click', () => {
    state.asanaProjects = null;
    state.asanaUsers = null;
    const cur = liveMeeting(m);
    if (cur) renderAsanaPanel(cur);
  });
  const openLink = document.createElement('button');
  openLink.className = 'btn small ghost'; openLink.textContent = 'Open in Asana ↗';
  openLink.addEventListener('click', () => {
    const p = state.asanaProjects.find((x) => String(x.id) === sel.value);
    if (p?.url) window.open(p.url, '_blank');
  });
  const projLabel = document.createElement('span');
  projLabel.className = 'muted';
  projLabel.textContent = 'Project';
  projRow.append(projLabel, sel, refresh, openLink);
  panel.appendChild(projRow);

  // Row 3 — extract action items (the only send action for Asana).
  const actionRow = document.createElement('div');
  actionRow.className = 'send-row';
  const st = statusEl();
  const extractBtn = document.createElement('button');
  extractBtn.className = 'btn small primary';
  extractBtn.textContent = '⚡ Create tasks from action items';
  extractBtn.disabled = sel.disabled;
  actionRow.append(extractBtn, st);
  panel.appendChild(actionRow);

  const aiBox = document.createElement('div');
  aiBox.className = 'ai-rows';
  panel.appendChild(aiBox);
  wireActionItems(extractBtn, aiBox, m, sel, st, {
    users: state.asanaUsers,
    onCreate: (f) => api.createAsanaTask(sel.value, {
      title: f.title,
      assigneeGid: f.assignee, // the <select> value is a user gid
      dueDate: f.dueDate,
    }),
  });
}

// Wires an extract button + rows box to the cached extraction, shared by both send panels.
// The panel is rebuilt from scratch on every destination switch, so previously extracted rows are
// restored from the meeting's cache (no AI call); the button then re-extracts with force.
// rowOpts is passed straight through to renderActionItemRows (Asana supplies users/onCreate).
function wireActionItems(btn, box, meeting, projectSel, st, rowOpts = {}) {
  const LABEL = '⚡ Create tasks from action items';
  const run = async (force) => {
    btn.disabled = true; btn.textContent = 'Extracting…';
    let r;
    try { r = await api.extractActionItems(meeting.id, { force }); } catch (err) { r = { items: [], error: err?.message || 'Extraction failed' }; }
    const items = r.items || [];
    btn.disabled = false;
    // Label tracks whether rows are on screen, not how the result arrived — otherwise the button
    // after a first extract would disagree with the identical state after a panel rebuild.
    btn.textContent = items.length ? 'Re-extract' : LABEL;
    if (r.error && !items.length) { st.className = 'send-status err'; st.textContent = `⚠ ${r.error}`; return; }
    // Mirror onto the in-memory meeting: current() reads state.meetings, which only refreshes on
    // listMeetings(), so without this the next panel rebuild would miss the cache and re-run the AI.
    // `meeting` may have been replaced in state.meetings while the AI ran — write to the live one.
    const target = state.meetings.find((x) => x.id === meeting.id);
    if (target) target.actionItems = items;
    meeting.actionItems = items;
    if (current()?.id !== meeting.id) return; // user moved on; the rows box is not theirs any more
    renderActionItemRows(box, items, projectSel, rowOpts);
  };
  if (meeting.actionItems?.length) { // cached — render immediately, no AI call
    btn.textContent = 'Re-extract';
    renderActionItemRows(box, meeting.actionItems, projectSel, rowOpts);
  }
  btn.addEventListener('click', () => run(btn.textContent === 'Re-extract'));
}

// Editable action-item grid, shared by the GetOverview and Asana panels.
// opts.users  — when supplied, the assignee cell is a <select> of real users (Asana, which
//               needs a user gid) instead of a free-text input (GetOverview).
// opts.onCreate(fields) — performs the create for one row and returns { ok, error }.
//               Defaults to GetOverview's createTask so existing callers are unchanged.
function renderActionItemRows(box, items, projectSel, opts = {}) {
  const { users, onCreate } = opts;
  box.innerHTML = '';
  const rowsBox = document.createElement('div');
  box.appendChild(rowsBox);
  const rows = [];

  // Best-effort match of an AI-extracted name to a real user: exact full name, then first
  // name, then email local-part. No match → Unassigned (never guess an arbitrary person).
  const matchUser = (name) => {
    const n = (name || '').trim().toLowerCase();
    if (!n || !users) return '';
    const exact = users.find((u) => u.name.toLowerCase() === n);
    if (exact) return exact.gid;
    const first = users.find((u) => u.name.toLowerCase().split(' ')[0] === n.split(' ')[0]);
    if (first) return first.gid;
    const byEmail = users.find((u) => u.email && u.email.toLowerCase().split('@')[0] === n);
    return byEmail ? byEmail.gid : '';
  };

  const mkRow = (item = { title: '', assignee: '', dueDate: '' }) => {
    const row = document.createElement('div');
    row.className = 'ai-row';
    const assigneeCell = users
      ? '<select class="ai-assignee"></select>'
      : `<input class="ai-assignee" value="${esc(item.assignee)}" placeholder="Assignee">`;
    row.innerHTML = `
      <input class="ai-title" value="${esc(item.title)}" placeholder="Task title">
      ${assigneeCell}
      <input class="ai-due" value="${esc(item.dueDate)}" placeholder="YYYY-MM-DD">
      <span class="ai-state"></span>
      <button class="btn small ghost ai-remove" title="Remove">×</button>`;
    if (users) {
      const sel = row.querySelector('.ai-assignee');
      sel.append(new Option('Unassigned', ''));
      for (const u of users) sel.append(new Option(u.name, u.gid));
      sel.value = matchUser(item.assignee);
    }
    row.querySelector('.ai-remove').addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      row.remove();
    });
    rows.push(row);
    rowsBox.appendChild(row);
  };

  items.forEach(mkRow);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn small ghost';
  addBtn.textContent = '+ Add task';
  addBtn.addEventListener('click', () => mkRow());

  const createBtn = document.createElement('button');
  createBtn.className = 'btn small primary';
  createBtn.textContent = 'Create tasks';
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    for (const row of rows) {
      const stEl = row.querySelector('.ai-state');
      if (stEl.textContent === '✓') continue;
      const title = row.querySelector('.ai-title').value.trim();
      if (!title) { stEl.textContent = '✕'; stEl.title = 'Title required'; continue; }
      stEl.textContent = '…';
      const fields = {
        title,
        assignee: row.querySelector('.ai-assignee').value.trim(),
        dueDate: row.querySelector('.ai-due').value.trim(),
      };
      const r = onCreate
        ? await onCreate(fields)
        : await api.createGetOverviewTask(projectSel.value, fields);
      stEl.textContent = r.ok ? '✓' : '✕';
      stEl.title = r.ok ? 'Created' : r.error;
    }
    createBtn.disabled = false;
  });
  box.append(addBtn, createBtn);
}

// ---------- settings ----------
// API keys now live on the backend — only local, non-secret prefs remain here.
const SETTINGS_FIELDS = [
  ['USER_DISPLAY_NAME', 'Your display name (mic channel label)'],
  ['AUTO_DELETE_DAYS', 'Auto-delete recordings after N days (0 = keep forever)'],
];
const SECRET = /KEY|Token/i;

async function openSettings() {
  const values = await api.getSettings();
  const box = $('settings-fields');
  box.innerHTML = '';
  for (const [key, label] of SETTINGS_FIELDS) {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = `<label>${esc(label)}</label>
      <input data-key="${key}" type="${SECRET.test(key) ? 'password' : 'text'}" value="${esc(values[key] || '')}">`;
    box.appendChild(f);
  }
  renderLegacy();
  $('modal-backdrop').classList.remove('hidden');
  $('settings-view').classList.remove('hidden');
  showTab('profile');
  renderAccount();
  renderSlack();
  renderAsana();
  closeChat();
  updateFab();
}

function showTab(name) {
  document.querySelectorAll('.settings-tabs .seg-toggle').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.settings-tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
}

// Show the Slack connect/disconnect block. Block appears only if OAuth is configured on
// the backend (state.flags.slack); connected state comes from the per-user slack-status IPC.
async function renderSlack() {
  const block = $('slack-block');
  block.classList.toggle('hidden', !state.flags.slack);
  if (!state.flags.slack) return;
  const { connected, team } = await api.slackStatus();
  state.slackConnected = connected;
  $('slack-signed-out').classList.toggle('hidden', connected);
  $('slack-signed-in').classList.toggle('hidden', !connected);
  if (connected) $('slack-team').textContent = team ? `Connected: ${team}` : 'Connected';
}

// Same two-level gate as renderSlack: the block appears only if Asana OAuth is configured
// on the backend; signed-in/out comes from the per-user asana-status IPC.
async function renderAsana() {
  const block = $('asana-block');
  block.classList.toggle('hidden', !state.flags.asana);
  if (!state.flags.asana) return;
  const { connected, user } = await api.asanaStatus();
  state.asanaConnected = connected;
  $('asana-signed-out').classList.toggle('hidden', connected);
  $('asana-signed-in').classList.toggle('hidden', !connected);
  if (connected) $('asana-user').textContent = user ? `Connected: ${user}` : 'Connected';
}

// ---------- account / sync ----------
// Pre-change recordings play and download exactly as before; they just are not seekable. The
// block hides itself when there is nothing to convert, so most users never see it.
async function renderLegacy() {
  const block = $('legacy-block');
  const status = $('legacy-status');
  let n = 0;
  try { n = await api.countLegacyRecordings(); } catch { n = 0; }
  block.classList.toggle('hidden', !n);
  if (!n) return;
  status.textContent = `${n} recording${n === 1 ? '' : 's'} made before MP4 support. `
    + 'They still play, but cannot be scrubbed. Converting is minutes of CPU each and runs one at a time in the background.';
  $('legacy-convert').disabled = false;
  $('legacy-convert').textContent = 'Convert to MP4';
}

async function renderAccount() {
  const { enabled, user } = await api.getUser();
  const block = $('account-block');
  block.classList.toggle('hidden', !enabled); // hide entirely if SSO not configured in this build
  const signedIn = enabled && !!user;
  if (enabled) {
    $('account-signed-out').classList.toggle('hidden', signedIn);
    $('account-signed-in').classList.toggle('hidden', !signedIn);
  }
  // modal head + sidebar chip both mirror the same user
  const label = signedIn ? (user.email || user.name || 'Signed in') : 'Account';
  $('account-email').textContent = label;
  const av = $('account-avatar');
  if (signedIn && user.avatar) { av.src = user.avatar; av.classList.remove('hidden'); } else av.classList.add('hidden');
  renderChip(enabled, user);
}

function renderChip(enabled, user) {
  const chipAv = $('chip-avatar');
  if (enabled && user) {
    $('chip-name').textContent = user.name || user.email || 'Signed in';
    $('chip-sub').textContent = user.name && user.email ? user.email : 'Signed in';
    if (user.avatar) { chipAv.src = user.avatar; chipAv.classList.remove('hidden'); $('chip-fallback').classList.add('hidden'); }
    else { chipAv.classList.add('hidden'); $('chip-fallback').classList.remove('hidden'); }
  } else {
    $('chip-name').textContent = enabled ? 'Not signed in' : 'Settings';
    $('chip-sub').textContent = enabled ? 'Tap to sign in' : 'Preferences';
    chipAv.classList.add('hidden'); $('chip-fallback').classList.remove('hidden');
  }
}

function closeSettings() {
  $('settings-view').classList.add('hidden');
  $('modal-backdrop').classList.add('hidden');
  updateFab();
}

// ---------- data plumbing ----------
// Light list item from a full meeting: the list must stay light (no transcript/chat), or every
// update to a meeting nobody has open would pin its whole transcript in renderer memory.
function lighten(meeting, prev) {
  const { transcript, chat, ...rest } = meeting;
  return {
    ...(prev || {}),
    ...rest,
    hasTranscript: rest.hasTranscript ?? (Array.isArray(transcript) ? transcript.length > 0 : prev?.hasTranscript),
    _light: true,
  };
}

function patchLocal(meeting) {
  if (!meeting || !meeting.id || meeting.deletedAt) return; // trashed meetings are not in this list
  const i = state.meetings.findIndex((m) => m.id === meeting.id);
  const prev = i >= 0 ? state.meetings[i] : null;
  let next = meeting.id === state.currentId || meeting._light ? meeting : lighten(meeting, prev);
  // An unsaved edit is newer than whatever main just sent.
  if (pendingSave && pendingSave.id === meeting.id) next = { ...next, ...pendingSave.patch };
  if (i >= 0) state.meetings[i] = next;
  else state.meetings.unshift(next);
}

function chatIsOpen() { return !$('chat-modal').classList.contains('hidden'); }
function rerenderChatIfOpen() {
  const m = current();
  if (m && chatIsOpen()) renderChat(m);
}

async function reload({ clearCurrent } = {}) {
  await flushSave(); // so the list read back below already contains the edit
  const [list, trash] = await Promise.all([api.listMeetings(), api.listTrash()]);
  state.meetings = list.map((m) => ({ ...m, _light: true }));
  state.trash = trash;
  if (clearCurrent || !state.meetings.some((m) => m.id === state.currentId)) state.currentId = null;
  if (state.currentId) await ensureFull(state.currentId);
  if (state.search) await refreshSearch();
  renderList();
  renderEditor();
  rerenderChatIfOpen();
}

// 1s-debounced autosave for title + content.
// The meeting id and the edited values are captured AT EDIT TIME. Reading them when the timer
// fired saved one meeting's notes into another whenever the user switched meetings within the
// second. Only fields the user actually edited go into the patch, so a title edit can never
// carry a stale (or live-preview) notes box along with it.
let pendingSave = null; // { id, patch, timer }

function hasPendingEdit(id, field) {
  return !!pendingSave && pendingSave.id === id && field in pendingSave.patch;
}

function queueSave(field) {
  const m = current();
  if (!m) return;
  if (pendingSave && pendingSave.id !== m.id) flushSave();
  if (!pendingSave) pendingSave = { id: m.id, patch: {}, timer: null };
  if (field === 'title') pendingSave.patch.title = $('note-title').value;
  if (field === 'content') {
    const notes = $('note-content');
    // The live streaming summary preview is read-only and is not the user's text: never save it.
    if (notes.readOnly) return;
    pendingSave.patch.content = notes.value;
  }
  Object.assign(m, pendingSave.patch); // mirror now so any re-render shows what was typed
  clearTimeout(pendingSave.timer);
  pendingSave.timer = setTimeout(flushSave, 1000);
}

// Run the pending save now. Safe to call any time; resolves when main has it.
function flushSave() {
  const p = pendingSave;
  if (!p) return Promise.resolve();
  pendingSave = null;
  clearTimeout(p.timer);
  const m = state.meetings.find((x) => x.id === p.id);
  if (!m || !Object.keys(p.patch).length) return Promise.resolve(); // deleted / gone meanwhile
  Object.assign(m, p.patch);
  renderList();
  return Promise.resolve(api.updateMeeting(p.id, p.patch))
    .catch((err) => console.error('save failed', err));
}

// Drop a pending edit without saving (its meeting is being deleted).
function discardSave(id) {
  if (pendingSave && pendingSave.id === id) { clearTimeout(pendingSave.timer); pendingSave = null; }
}

// ---------- theme ----------
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('theme-toggle');
  if (btn) { btn.textContent = t === 'light' ? '☀' : '☾'; btn.title = t === 'light' ? 'Switch to dark' : 'Switch to light'; }
}

// ---------- wiring ----------
async function init() {
  for (const id of ['loader-logo', 'brand-logo', 'empty-logo']) $(id).src = logoUrl;
  // apply saved theme before anything renders (no flash of wrong theme)
  applyTheme((await api.getSettings()).THEME || 'dark');
  $('theme-toggle').addEventListener('click', () => {
    const next = state.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    api.saveSettings({ THEME: next });
  });
  const _ver = await api.getAppVersion();
  $('app-version').textContent = `v${_ver}`;
  $('app-version').title = `Your Call AI v${_ver}`; // hover shows full build — auto-update sanity check
  state.flags = await api.getEffectiveConfig();
  if (state.flags.slack) state.slackConnected = (await api.slackStatus()).connected;
  if (state.flags.asana) state.asanaConnected = (await api.asanaStatus()).connected;

  api.onStatus((s) => { state.status = s || { state: 'idle', detail: '', recording: false }; renderStatus(); });
  api.onSyncStatus(({ state: st }) => { $('sync-dot').className = `sync-dot ${st}`; if (st === 'synced') reload(); });
  renderAccount(); // populate the sidebar user chip on startup
  api.onRecordingComplete(async (meeting) => {
    if (!meeting) return;
    if (!isPlaceholderSummary(meeting.content)) delete state.liveSummary[meeting.id];
    await flushSave();
    await reload(); // re-renders the open meeting (and its chat) if it IS this recording
    // Auto-open the new recording only when nothing is open (reload() clears a vanished one).
    // Never pull the user out of a meeting they are reading, never close Settings/chat for it.
    if (!state.currentId && state.meetings.some((m) => m.id === meeting.id)) {
      await selectMeeting(meeting.id, { keepPanels: true });
    }
  });
  api.onChatDelta(({ id, delta, reset }) => {
    const s = state.chatStream;
    if (!s || s.id !== id) return;
    if (reset) {
      // The AI client retried a stalled stream and re-streams the answer from the start.
      s.text = '';
      s.el.textContent = 'Thinking…';
      s.el.classList.add('thinking');
      return;
    }
    s.text += delta || '';
    s.el.textContent = s.text;
    s.el.classList.remove('thinking');
    $('chat-thread').scrollTop = $('chat-thread').scrollHeight;
  });
  // Paint the live summary preview into the notes box, unless the user is editing it.
  const paintLiveSummary = (recordingId) => {
    const m = current();
    if (!m || m.id !== recordingId || state.view !== 'summary' || !isPlaceholderSummary(m.content)) return;
    const notes = $('note-content');
    if (!notes.readOnly && (document.activeElement === notes || hasPendingEdit(m.id, 'content'))) return;
    notes.value = state.liveSummary[recordingId] || '';
    notes.readOnly = true;
  };
  // Progress for the pipeline. While a recording is live, it describes ANOTHER meeting: show it
  // as detail but never replace the recording state (that hid the Stop button mid-meeting).
  const setProgress = (st, detail) => {
    state.status = { ...state.status, state: isRecording() ? 'recording' : st, detail: isRecording() ? `Recording · ${detail}` : detail };
  };
  api.onTranscribeProgress(({ recordingId, stage, detail }) => {
    if (stage === 'summary-delta') {
      // Summary text as it is generated. Not a status change — fills the open note live.
      state.liveSummary[recordingId] = (state.liveSummary[recordingId] || '') + (detail || '');
      paintLiveSummary(recordingId);
      return;
    }
    if (stage === 'summary-reset') {
      // A stalled summary stream was retried; it re-streams from the start.
      state.liveSummary[recordingId] = '';
      paintLiveSummary(recordingId);
      return;
    }
    if (stage === 'transcribing') setProgress('transcribing', 'Transcribing…');
    if (stage === 'resolving-names') setProgress('processing', 'Resolving names and summarizing…');
    if (stage === 'summarizing') {
      state.liveSummary[recordingId] = ''; // a fresh run (or retry) starts a fresh preview
      setProgress('processing', 'Generating summary…');
    }
    // Maps onto the existing 'processing' state rather than introducing a new one: renderStatus's
    // labels map falls through via `labels[st] || st`, so a new state string would render the
    // literal word "normalizing" in the pill.
    if (stage === 'normalizing') setProgress('processing', `Preparing video${detail ? ` ${detail}` : '…'}`);
    renderStatus();
  });

  // Video normalization finishes independently of the pipeline and can land minutes later.
  // Deliberately NOT the recording-complete channel: that one may select the meeting, which
  // would yank the user out of whatever they were reading.
  api.onMeetingUpdated((meeting) => {
    if (!meeting || meeting.deletedAt) return;
    patchLocal(meeting); // stored light unless it is the open meeting
    renderList();
    if (meeting.id === state.currentId) {
      // A light update for the open meeting (Re-resolve all) drops its transcript: fetch it back.
      if (meeting._light) ensureFull(meeting.id).then(() => { if (meeting.id === state.currentId) { renderEditor(); rerenderChatIfOpen(); } });
      else renderEditor(); // reads current() from state
    }
  });

  // Start/stop: one call at a time. A double click used to fire start twice or stop+start.
  const recordAction = async (fn) => {
    if (recordBusy) return;
    recordBusy = true; renderStatus();
    try { await fn(); } catch (err) { console.error(err); }
    finally { recordBusy = false; renderStatus(); }
  };
  $('btn-huddle').addEventListener('click', () => recordAction(() =>
    (isRecording() ? api.stopRecording() : api.startHuddle())));
  $('btn-record').addEventListener('click', () => recordAction(() =>
    (isRecording() ? api.stopRecording() : api.startDetectedRecording())));
  $('user-chip').addEventListener('click', openSettings);

  $('legacy-convert').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Queueing…';
    let r;
    try { r = await api.convertLegacyRecordings(); } catch (err) { r = { ok: false, error: err?.message }; }
    // #legacy-result sits outside #legacy-block, which renderLegacy() hides once nothing is left.
    $('legacy-result').textContent = r && r.ok
      ? `Queued ${r.queued} — converting in the background, one at a time.`
      : `⚠ ${(r && r.error) || 'Failed'}`;
    b.textContent = 'Convert to MP4';
    // Renaming the sources means they are no longer "legacy"; re-read so the count is honest.
    await renderLegacy();
    await reload();
  });
  $('names-reresolve-all').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!confirm('Re-identify speakers in every saved meeting? This runs one AI call per meeting in the background. Your own renames are kept.')) return;
    b.disabled = true; $('names-result').textContent = 'Working… (progress in the status bar)';
    const r = await api.reresolveAllNames();
    b.disabled = false;
    $('names-result').textContent = r.ok
      ? `Done: ${r.total} meetings, names changed in ${r.changed}${r.failed ? `, ${r.failed} failed` : ''}.`
      : `⚠ ${r.error}`;
    await reload();
  });
  $('settings-close').addEventListener('click', closeSettings);
  $('modal-backdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-view').classList.contains('hidden')) closeSettings();
  });
  document.querySelectorAll('.settings-tabs .seg-toggle').forEach((b) =>
    b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('btn-sign-in').addEventListener('click', () => api.signIn());
  $('btn-sign-out').addEventListener('click', async () => { await api.signOut(); });
  $('btn-sync-now').addEventListener('click', async () => {
    const b = $('btn-sync-now');
    b.disabled = true;
    $('account-status').textContent = 'Syncing…';
    let r;
    try { r = await api.syncNow(); } catch (err) { r = { ok: false, error: err?.message }; }
    finally { b.disabled = false; }
    // No reload here: a successful sync emits sync-status 'synced', whose handler reloads.
    $('account-status').textContent = r && r.ok !== false ? 'Synced' : `⚠ Sync failed: ${(r && r.error) || 'unknown error'}`;
  });
  api.onAuthChanged(() => { renderAccount(); reload(); }); // pulled meetings appear after login

  $('btn-slack-connect').addEventListener('click', async () => {
    $('slack-status').textContent = 'Opening Slack…';
    const r = await api.slackConnect();
    $('slack-status').textContent = r.ok ? 'Continue in your browser…' : `⚠ ${r.error || 'Could not start Slack connect'}`;
  });
  $('btn-slack-disconnect').addEventListener('click', async () => { await api.slackDisconnect(); });
  // New workspace → reload channels. renderSlack() sets state.slackConnected, which the panel
  // gates on, so it must finish before the editor re-renders or the panel shows the old state.
  api.onSlackChanged(async () => {
    state.slackTargets = null;
    try { await renderSlack(); } catch (err) { console.error(err); }
    renderEditor();
  });

  $('btn-asana-connect').addEventListener('click', async () => {
    $('asana-status').textContent = 'Opening Asana…';
    const r = await api.asanaConnect();
    $('asana-status').textContent = r.ok ? 'Continue in your browser…' : `⚠ ${r.error || 'Could not start Asana connect'}`;
  });
  $('btn-asana-disconnect').addEventListener('click', async () => { await api.asanaDisconnect(); });
  // Backend flags can land after boot (the /api/config fetch isn't awaited in main). Adopt them
  // so a newly-enabled integration appears without a restart, and refresh the panels that gate
  // on them — including the connected-state reads, or a flag flipping on would show the connect
  // prompt but never load its lists.
  api.onConfigChanged(async (flags) => {
    state.flags = flags;
    if (flags.slack) state.slackConnected = (await api.slackStatus()).connected;
    if (flags.asana) state.asanaConnected = (await api.asanaStatus()).connected;
    renderSlack();
    renderAsana();
    renderEditor();
  });

  api.onAsanaChanged(async () => { // new account → drop the previous one's workspaces/projects/people
    state.asanaWorkspaces = null;
    state.asanaWorkspaceGid = null;
    state.asanaProjects = null;
    state.asanaUsers = null;
    try { await renderAsana(); } catch (err) { console.error(err); } // sets state.asanaConnected first
    renderEditor();
  });
  $('settings-save').addEventListener('click', async () => {
    const patch = {};
    document.querySelectorAll('#settings-fields input').forEach((i) => { patch[i.dataset.key] = i.value; });
    await api.saveSettings(patch);
    state.flags = await api.getEffectiveConfig();
    state.slackTargets = null;
    state.overviewProjects = null;
    state.asanaWorkspaces = null;
    state.asanaProjects = null;
    state.asanaUsers = null;
    $('settings-status').textContent = '✓ Saved — applied immediately';
    setTimeout(() => { $('settings-status').textContent = ''; }, 2500);
    renderStatus();
  });

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { await refreshSearch(); renderList(); }, 150);
  });
  $('range-filter').addEventListener('change', (e) => { state.range = e.target.value; renderList(); });
  $('note-title').addEventListener('input', () => queueSave('title'));
  $('note-content').addEventListener('input', () => queueSave('content'));
  window.addEventListener('beforeunload', () => { flushSave(); });

  $('chat-fab').addEventListener('click', openChat);
  $('chat-close').addEventListener('click', closeChat);
  $('chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  document.querySelectorAll('.view-toggle .seg-toggle').forEach((b) =>
    b.addEventListener('click', () => { state.view = b.dataset.view; renderEditor(); }));
  document.querySelectorAll('.send-toggle .seg-toggle').forEach((b) =>
    b.addEventListener('click', () => { state.dest = b.dataset.dest; renderSendBlock(current()); }));

  await reload();
  renderStatus();
  $('loader').classList.add('fade');
  setTimeout(() => $('loader').remove(), 500);
}

init().catch((err) => {
  console.error(err);
  $('loader').innerHTML = `<div class="loader-box"><p>Failed to start: ${esc(err.message)}</p></div>`;
});
