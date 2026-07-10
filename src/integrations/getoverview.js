// GetOverview (internal PM tool). All helpers return { ok, ... } | { ok:false, error }, never throw.

const MAX_TRANSCRIPT_BYTES = 700 * 1024;

async function goFetch(pathname, options = {}) {
  const base = process.env.GetOverview_BASE_URL; // call-time reads
  const token = process.env.GetOverview_Access_Token;
  if (!base || !token) {
    return { ok: false, error: 'GetOverview not configured — add GetOverview_BASE_URL and GetOverview_Access_Token in Settings.' };
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      return { ok: false, error: body.error || body.message || `GetOverview ${res.status}` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, error: `GetOverview request failed: ${err.message}` };
  }
}

async function listProjects() {
  const res = await goFetch('/api/v1/projects');
  if (!res.ok) return res;
  const projects = (Array.isArray(res.body) ? res.body : res.body.projects || res.body.data || [])
    .map((p) => ({ id: p.id, name: p.name, status: p.status || 'Other', url: p.url || '' }));
  return { ok: true, projects };
}

async function createTask(projectId, { title, assignee, dueDate, description }) {
  if (!title) return { ok: false, error: 'Task title is required.' };
  const res = await goFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title, assignee: assignee || '', dueDate: dueDate || '', description: description || '' }),
  });
  return res.ok ? { ok: true, task: res.body } : res;
}

// Returns 202 { jobId, status } — don't poll. Payload trimmed to 700 KB.
async function sendTranscript(projectId, { title, text }) {
  let payload = text || '';
  while (Buffer.byteLength(payload, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    payload = payload.slice(0, Math.floor(payload.length * 0.9));
  }
  const pathname = projectId
    ? `/api/v1/projects/${encodeURIComponent(projectId)}/transcripts`
    : '/api/v1/transcripts';
  const res = await goFetch(pathname, { method: 'POST', body: JSON.stringify({ title, text: payload }) });
  return res.ok ? { ok: true, jobId: res.body.jobId, status: res.body.status } : res;
}

module.exports = { listProjects, createTask, sendTranscript };
