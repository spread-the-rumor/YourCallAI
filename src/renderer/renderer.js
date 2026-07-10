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
  actionItems: [],
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
    recording: 'Recording',
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
  if (st === 'recording') {
    recBtn.classList.remove('hidden');
    recBtn.classList.add('stop');
    recBtn.textContent = '■ Stop Recording';
    huddleBtn.classList.add('stop');
    huddleBtn.textContent = '■ Stop';
  } else {
    huddleBtn.classList.remove('stop');
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
  state.actionItems = [];
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

  document.querySelectorAll('.view-toggle .seg-toggle').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  $('view-summary').classList.toggle('hidden', state.view !== 'summary');
  $('view-transcript').classList.toggle('hidden', state.view !== 'transcript');

  if (state.view === 'summary') { $('note-content').value = m.content || ''; renderActionRow(m); renderSendBlock(m); }
  if (state.view === 'transcript') renderTranscript(m);
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
    add('▶ Recording', () => window.open(m.videoUrl, '_blank'));
    add('⬇ Download', async (b) => {
      b.disabled = true; b.textContent = 'Saving…';
      const r = await api.saveRecording(m.id);
      b.disabled = false; b.textContent = r.ok ? '✓ Saved' : (r.canceled ? '⬇ Download' : '⚠ Failed');
      setTimeout(() => { b.textContent = '⬇ Download'; }, 2500);
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

// ---------- transcript view + rename (§7 Layer 3) ----------
function renderTranscript(m) {
  const box = $('view-transcript');
  box.innerHTML = '';
  if (!m.transcript?.length) {
    box.innerHTML = '<p class="muted">No transcript for this meeting.</p>';
    return;
  }
  for (const seg of m.transcript) {
    const el = document.createElement('div');
    el.className = 'seg';
    const nameEl = document.createElement('div');
    nameEl.className = 'speaker' + (seg.channel === 0 ? ' you' : '');
    nameEl.textContent = segSpeaker(seg);
    if (seg.channel !== 0) {
      nameEl.title = 'Click to rename this speaker';
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
function renderSendBlock(m) {
  document.querySelectorAll('.send-toggle .seg-toggle').forEach((b) =>
    b.classList.toggle('active', b.dataset.dest === state.dest));
  $('send-slack').classList.toggle('hidden', state.dest !== 'slack');
  $('send-getoverview').classList.toggle('hidden', state.dest !== 'getoverview');
  if (state.dest === 'slack') renderSlackPanel(m);
  else renderOverviewPanel(m);
}

function statusEl(cls = '') {
  const s = document.createElement('span');
  s.className = `send-status ${cls}`;
  return s;
}

async function renderSlackPanel(m) {
  const panel = $('send-slack');
  if (!state.flags.slack) {
    panel.innerHTML = '<span class="muted">Slack not configured — add Bot_User_OAuth_Token in Settings.</span>';
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
  for (const c of state.slackTargets.channels) gCh.append(new Option(`#${c.name}`, `channel:${c.id}`));
  const gUs = document.createElement('optgroup'); gUs.label = 'People';
  for (const u of state.slackTargets.users) gUs.append(new Option(u.name, `user:${u.id}`));
  sel.append(gCh, gUs);
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
    panel.innerHTML = '<span class="muted">GetOverview not configured — add its URL and token in Settings.</span>';
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
  extractBtn.addEventListener('click', async () => {
    extractBtn.disabled = true; extractBtn.textContent = 'Extracting…';
    const r = await api.extractActionItems(m.id);
    extractBtn.disabled = false; extractBtn.textContent = '⚡ Create tasks from action items';
    if (r.error && !r.items.length) { st.className = 'send-status err'; st.textContent = `⚠ ${r.error}`; return; }
    renderActionItemRows(aiBox, r.items, sel);
  });
}

function renderActionItemRows(box, items, projectSel) {
  box.innerHTML = '';
  const rowsBox = document.createElement('div');
  box.appendChild(rowsBox);
  const rows = [];

  const mkRow = (item = { title: '', assignee: '', dueDate: '' }) => {
    const row = document.createElement('div');
    row.className = 'ai-row';
    row.innerHTML = `
      <input class="ai-title" value="${esc(item.title)}" placeholder="Task title">
      <input class="ai-assignee" value="${esc(item.assignee)}" placeholder="Assignee">
      <input class="ai-due" value="${esc(item.dueDate)}" placeholder="YYYY-MM-DD">
      <span class="ai-state"></span>
      <button class="btn small ghost ai-remove" title="Remove">×</button>`;
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
      const r = await api.createGetOverviewTask(projectSel.value, {
        title,
        assignee: row.querySelector('.ai-assignee').value.trim(),
        dueDate: row.querySelector('.ai-due').value.trim(),
      });
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
  $('editor').classList.add('hidden');
  $('empty-state').classList.add('hidden');
  $('settings-view').classList.remove('hidden');
  closeChat();
  updateFab();
}
function closeSettings() {
  $('settings-view').classList.add('hidden');
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

// ---------- wiring ----------
async function init() {
  for (const id of ['loader-logo', 'brand-logo', 'empty-logo']) $(id).src = logoUrl;
  $('app-version').textContent = `v${await api.getAppVersion()}`;
  state.flags = await api.getEffectiveConfig();

  api.onStatus((s) => { state.status = s; renderStatus(); });
  api.onRecordingComplete((meeting) => {
    patchLocal(meeting);
    reload().then(() => selectMeeting(meeting.id));
  });
  api.onTranscribeProgress(({ stage }) => {
    if (stage === 'transcribing') state.status = { state: 'transcribing', detail: 'Transcribing…' };
    if (stage === 'resolving-names') state.status = { state: 'processing', detail: 'Resolving speaker names…' };
    if (stage === 'summarizing') state.status = { state: 'processing', detail: 'Generating summary…' };
    renderStatus();
  });

  $('btn-huddle').addEventListener('click', async () => {
    if (state.status.state === 'recording') await api.stopRecording();
    else await api.startHuddle();
  });
  $('btn-record').addEventListener('click', async () => {
    if (state.status.state === 'recording') await api.stopRecording();
    else await api.startDetectedRecording();
  });
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-done').addEventListener('click', () => { closeSettings(); renderEditor(); });
  $('settings-save').addEventListener('click', async () => {
    const patch = {};
    document.querySelectorAll('#settings-fields input').forEach((i) => { patch[i.dataset.key] = i.value; });
    await api.saveSettings(patch);
    state.flags = await api.getEffectiveConfig();
    state.slackTargets = null;
    state.overviewProjects = null;
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
