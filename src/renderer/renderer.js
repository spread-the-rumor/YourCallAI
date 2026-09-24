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
  range: 'all',       // all | week | month (date filter next to search)
  flags: {},
  status: { state: 'idle', detail: '' },
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
  const days = Math.floor((now - d) / 86400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
function fmtDuration(transcript) {
  if (!transcript?.length) return '';
  const last = transcript[transcript.length - 1];
  const w = last.words?.[last.words.length - 1];
  const secs = w?.end_timestamp?.relative || 0;
  const m = Math.round(secs / 60);
  return m >= 1 ? `${m} min` : `${Math.round(secs)}s`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- status pill + record buttons ----------
function renderStatus() {
  const pill = $('status-pill'), text = $('status-text');
  const { state: st, detail } = state.status;
  pill.className = 'status-pill';
  const labels = {
    idle: state.flags.deepgram ? 'Idle' : 'Idle — add Deepgram key in Settings',
    'meeting-detected': 'Meeting detected',
    recording: detail || 'Recording',
    processing: detail || 'Processing…',
    transcribing: detail || 'Transcribing…',
    error: detail || 'Error',
  };
  text.textContent = labels[st] || st;
  if (st === 'recording') pill.classList.add('recording');
  else if (st === 'meeting-detected') pill.classList.add('detected');
  else if (st === 'processing' || st === 'transcribing') pill.classList.add('busy');
  else if (st === 'error') pill.classList.add('error');

  const recBtn = $('btn-record'), huddleBtn = $('btn-huddle');
  // While recording there is exactly ONE stop control (#btn-record). Huddle is a *start* path
  // only; a second stop button beside it just made users guess which one ends the meeting.
  if (st === 'recording') {
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
function matches(m, q) {
  if (!q) return true;
  const hay = `${m.title} ${m.content || ''} ${(m.transcript || []).map(segText).join(' ')}`.toLowerCase();
  return hay.includes(q);
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
    await api.deleteMeeting(m.id);
    await reload(m.id === state.currentId ? { clearCurrent: true } : {});
  });
  return el;
}

function renderList() {
  const list = $('meeting-list');
  list.innerHTML = '';
  const q = state.search.toLowerCase();
  const shown = state.meetings.filter((m) => matches(m, q) && inRange(m, state.range));

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
function selectMeeting(id) {
  state.currentId = id;
  state.view = 'summary';
  closeSettings();
  closeChat();
  renderList();
  renderEditor();
}

function renderEditor() {
  const m = current();
  $('empty-state').classList.toggle('hidden', !!m);
  $('editor').classList.toggle('hidden', !m);
  updateFab();
  if (!m) return;

  $('note-title').value = m.title;
  const participants = [...new Set((m.transcript || []).map(segSpeaker))];
  const parts = [
    new Date(m.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
    fmtDuration(m.transcript),
    participants.length ? participants.join(', ') : null,
  ].filter(Boolean);
  $('meta-line').textContent = parts.join('  ·  ');
  renderCaptureWarning(m);

  document.querySelectorAll('.view-toggle .seg-toggle').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  $('view-summary').classList.toggle('hidden', state.view !== 'summary');
  $('view-transcript').classList.toggle('hidden', state.view !== 'transcript');

  if (state.view === 'summary') { $('note-content').value = m.content || ''; renderActionRow(m); renderSendBlock(m); }
  if (state.view === 'transcript') renderTranscript(m);
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
      const r = await api.openRecording(m.id);
      b.disabled = false;
      b.textContent = r && !r.ok ? `⚠ ${(r.error || 'Could not open').slice(0, 48)}` : '▶ Open in player';
      if (r && !r.ok) setTimeout(() => { b.textContent = '▶ Open in player'; }, 4000);
      reload();
    });
    add('⬇ Download', async (b) => {
      b.disabled = true; b.textContent = 'Saving…';
      const r = await api.saveRecording(m.id);
      b.disabled = false;
      b.textContent = r.ok ? '✓ Saved' : (r.canceled ? '⬇ Download' : `⚠ ${(r.error || 'Failed').slice(0, 48)}`);
      setTimeout(() => { b.textContent = '⬇ Download'; }, r.ok ? 2500 : 4000);
      reload();
    });
  }
  if (m.transcript) {
    add('Export .txt', () => api.saveTranscript(m.id, 'txt'));
    add('Export .json', () => api.saveTranscript(m.id, 'json'));
  } else {
    add('↻ Retry transcription', async (b) => {
      b.disabled = true; b.textContent = 'Retrying…';
      await api.retryTranscription(m.id);
    }, { primary: true });
  }
  if (m.transcript && summaryFailed(m)) {
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
    if (seg.channel !== 0) {
      nameEl.title = unverified
        ? `Unverified — inferred from ${SOURCE_LABELS[info.source] || info.source}. Click to correct.`
        : 'Click to rename this speaker';
      nameEl.addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = segSpeaker(seg);
        nameEl.replaceWith(input);
        input.focus(); input.select();
        const commit = async () => {
          const v = input.value.trim();
          if (v && v !== segSpeaker(seg)) {
            const r = await api.renameSpeaker(m.id, seg.channel, seg.diarizedSpeaker, v);
            if (r.ok) { patchLocal(r.meeting); renderEditor(); return; }
          }
          renderTranscript(current());
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') renderTranscript(current()); });
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
function openChat() {
  const m = current();
  if (!m) return;
  $('chat-modal').classList.remove('hidden');
  $('chat-fab').classList.add('open');
  renderChat(m);
  $('chat-input').focus();
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

function renderChat(m) {
  const thread = $('chat-thread');
  thread.innerHTML = '';
  for (const t of m.chat || []) {
    const b = document.createElement('div');
    b.className = `bubble ${t.role}`;
    b.textContent = t.content;
    thread.appendChild(b);
  }
  thread.scrollTop = thread.scrollHeight;
}

async function sendChat() {
  const m = current();
  const input = $('chat-input');
  const q = input.value.trim();
  if (!m || !q) return;
  input.value = '';
  m.chat = [...(m.chat || []), { role: 'user', content: q }];
  renderChat(m);
  const thinking = document.createElement('div');
  thinking.className = 'bubble assistant thinking';
  thinking.textContent = 'Thinking…';
  $('chat-thread').appendChild(thinking);
  $('chat-thread').scrollTop = $('chat-thread').scrollHeight;
  const { answer } = await api.askMeeting(m.id, q);
  m.chat = [...m.chat, { role: 'assistant', content: answer }];
  if (state.currentId === m.id && !$('chat-modal').classList.contains('hidden')) renderChat(m);
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
  panel.innerHTML = '<span class="muted">Loading Slack channels…</span>';
  if (!state.slackTargets) {
    let ch, us;
    try {
      // Serial, not parallel: two Tier-2 methods fired together trip Slack's rate limit. slack.js caches each.
      ch = await api.listSlackChannels();
      us = await api.listSlackUsers();
    } catch (err) {
      panel.innerHTML = `<span class="send-status err">${esc(err.message || 'Slack request failed')}</span>`;
      return;
    }
    if (!ch.ok) { panel.innerHTML = `<span class="send-status err">${esc(ch.error)}</span>`; return; }
    state.slackTargets = { channels: ch.channels || [], users: us.ok ? us.users : [] };
  }
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
    const [type, id] = sel.value.split(':');
    btn.disabled = true; st.textContent = 'Sending…'; st.className = 'send-status';
    // Send the EDITED note text; no localhost video links.
    const text = `*${m.title}*\n\n${$('note-content').value}`;
    const r = await api.sendToSlack({ type, id }, text);
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
  panel.innerHTML = '<span class="muted">Loading projects…</span>';
  if (!state.overviewProjects) {
    const r = await api.listGetOverviewProjects();
    if (!r.ok) { panel.innerHTML = `<span class="send-status err">${esc(r.error)}</span>`; return; }
    state.overviewProjects = r.projects || [];
  }
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
  refresh.addEventListener('click', () => { state.overviewProjects = null; renderOverviewPanel(m); });
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
      b.disabled = true; st.textContent = 'Sending…'; st.className = 'send-status';
      const r = await api.sendGetOverviewTranscript(sel.value, m.id, kind);
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
  panel.innerHTML = '<span class="muted">Loading Asana workspaces…</span>';

  if (!state.asanaWorkspaces) {
    const r = await api.listAsanaWorkspaces();
    if (!r.ok) { panel.innerHTML = `<span class="send-status err">${esc(r.error)}</span>`; return; }
    state.asanaWorkspaces = r.workspaces || [];
  }
  if (!state.asanaWorkspaces.length) {
    panel.innerHTML = '<span class="muted">No Asana workspaces found for this account.</span>';
    return;
  }
  // Default to the first workspace; keep the user's choice across re-renders.
  if (!state.asanaWorkspaces.some((w) => w.gid === state.asanaWorkspaceGid)) {
    state.asanaWorkspaceGid = state.asanaWorkspaces[0].gid;
  }

  if (!state.asanaProjects) {
    const r = await api.listAsanaProjects(state.asanaWorkspaceGid);
    if (!r.ok) { panel.innerHTML = `<span class="send-status err">${esc(r.error)}</span>`; return; }
    state.asanaProjects = r.projects || [];
  }
  // Assignee list is best-effort: a failure just means the dropdowns show Unassigned only.
  if (!state.asanaUsers) {
    const r = await api.listAsanaUsers(state.asanaWorkspaceGid);
    state.asanaUsers = r.ok ? (r.users || []) : [];
  }
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
    renderAsanaPanel(m);
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
    renderAsanaPanel(m);
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
    const r = await api.extractActionItems(meeting.id, { force });
    btn.disabled = false;
    // Label tracks whether rows are on screen, not how the result arrived — otherwise the button
    // after a first extract would disagree with the identical state after a panel rebuild.
    btn.textContent = r.items?.length ? 'Re-extract' : LABEL;
    if (r.error && !r.items.length) { st.className = 'send-status err'; st.textContent = `⚠ ${r.error}`; return; }
    // Mirror onto the in-memory meeting: current() reads state.meetings, which only refreshes on
    // listMeetings(), so without this the next panel rebuild would miss the cache and re-run the AI.
    meeting.actionItems = r.items;
    renderActionItemRows(box, r.items, projectSel, rowOpts);
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
function patchLocal(meeting) {
  const i = state.meetings.findIndex((m) => m.id === meeting.id);
  if (i >= 0) state.meetings[i] = meeting;
  else state.meetings.unshift(meeting);
}

async function reload({ clearCurrent } = {}) {
  [state.meetings, state.trash] = await Promise.all([api.listMeetings(), api.listTrash()]);
  if (clearCurrent || !state.meetings.some((m) => m.id === state.currentId)) state.currentId = null;
  renderList();
  renderEditor();
}

// 1s-debounced autosave for title + content
let saveTimer = null;
function queueSave() {
  const m = current();
  if (!m) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = { title: $('note-title').value, content: $('note-content').value };
    m.title = patch.title;
    m.content = patch.content;
    renderList();
    await api.updateMeeting(m.id, patch);
  }, 1000);
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

  api.onStatus((s) => { state.status = s; renderStatus(); });
  api.onSyncStatus(({ state: st }) => { $('sync-dot').className = `sync-dot ${st}`; if (st === 'synced') reload(); });
  renderAccount(); // populate the sidebar user chip on startup
  api.onRecordingComplete((meeting) => {
    patchLocal(meeting);
    reload().then(() => selectMeeting(meeting.id));
  });
  api.onTranscribeProgress(({ stage, detail }) => {
    if (stage === 'transcribing') state.status = { state: 'transcribing', detail: 'Transcribing…' };
    if (stage === 'resolving-names') state.status = { state: 'processing', detail: 'Resolving speaker names…' };
    if (stage === 'summarizing') state.status = { state: 'processing', detail: 'Generating summary…' };
    // Maps onto the existing 'processing' state rather than introducing a new one: renderStatus's
    // labels map falls through via `labels[st] || st`, so a new state string would render the
    // literal word "normalizing" in the pill.
    if (stage === 'normalizing') state.status = { state: 'processing', detail: `Preparing video${detail ? ` ${detail}` : '…'}` };
    renderStatus();
  });

  // Video normalization finishes independently of the pipeline and can land minutes later.
  // Deliberately NOT the recording-complete channel: that one calls reload().then(selectMeeting),
  // which would yank the user out of whatever they were reading.
  api.onMeetingUpdated((meeting) => {
    if (!meeting) return;
    patchLocal(meeting);
    renderList();
    if (meeting.id === state.currentId) renderEditor(); // reads current() from state
  });

  $('btn-huddle').addEventListener('click', async () => {
    if (state.status.state === 'recording') await api.stopRecording();
    else await api.startHuddle();
  });
  $('btn-record').addEventListener('click', async () => {
    if (state.status.state === 'recording') await api.stopRecording();
    else await api.startDetectedRecording();
  });
  $('user-chip').addEventListener('click', openSettings);

  $('legacy-convert').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Queueing…';
    const r = await api.convertLegacyRecordings();
    $('legacy-result').textContent = r && r.ok
      ? `Queued ${r.queued} — converting in the background, one at a time.`
      : `⚠ ${(r && r.error) || 'Failed'}`;
    b.textContent = 'Convert to MP4';
    // Renaming the sources means they are no longer "legacy"; re-read so the count is honest.
    await renderLegacy();
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
    $('account-status').textContent = 'Syncing…';
    await api.syncNow();
    await reload();
    $('account-status').textContent = 'Synced';
  });
  api.onAuthChanged(() => { renderAccount(); reload(); }); // pulled meetings appear after login

  $('btn-slack-connect').addEventListener('click', async () => {
    $('slack-status').textContent = 'Opening Slack…';
    const r = await api.slackConnect();
    $('slack-status').textContent = r.ok ? 'Continue in your browser…' : `⚠ ${r.error || 'Could not start Slack connect'}`;
  });
  $('btn-slack-disconnect').addEventListener('click', async () => { await api.slackDisconnect(); });
  api.onSlackChanged(() => { state.slackTargets = null; renderSlack(); renderEditor(); }); // new workspace → reload channels

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

  api.onAsanaChanged(() => { // new account → drop the previous one's workspaces/projects/people
    state.asanaWorkspaces = null;
    state.asanaWorkspaceGid = null;
    state.asanaProjects = null;
    state.asanaUsers = null;
    renderAsana();
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

  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
  $('range-filter').addEventListener('change', (e) => { state.range = e.target.value; renderList(); });
  $('note-title').addEventListener('input', queueSave);
  $('note-content').addEventListener('input', queueSave);

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
