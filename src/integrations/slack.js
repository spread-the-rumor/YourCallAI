// Slack Web API helpers. All return { ok, ... } | { ok:false, error } and never throw.
// Slack returns HTTP 200 with { ok:false, error } on logical failures — always check parsed ok.
// Bot scopes: chat:write, channels:read, groups:read, channels:join, users:read, im:write.
const path = require('path');
const { app } = require('electron');
const { JsonFile } = require('../jsonFile');
const { proxyPost } = require('../proxy');

// Persistent cache of channel/user lists. Tier-2 methods (conversations.list, users.list)
// rate-limit hard; on 429 we serve the last good lists instead of erroring the whole panel.
let cacheFile;
const cache = () => (cacheFile ||= new JsonFile(path.join(app.getPath('userData'), 'slack-cache.json'), {}));

// Calls go through the Vercel proxy, which injects the bot token server-side.
async function slackApi(method, params = {}) {
  try {
    // ponytail: retry only on 429; other failures return immediately. 3 tries max.
    for (let attempt = 0; ; attempt++) {
      const res = await proxyPost('/api/slack', { method, params }, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429 && attempt < 3) {
        // ponytail: cap back-off at 5s so 3 retries fail fast (~15s) instead of sleeping Slack's 30-60s Retry-After thrice
        const wait = Math.min(parseInt(res.headers.get('retry-after'), 10) || 1, 5) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const json = await res.json();
      if (!json.ok) return { ok: false, error: json.error || `Slack ${method} failed` };
      return json;
    }
  } catch (err) {
    return { ok: false, error: `Slack request failed: ${err.message}` };
  }
}

async function listSlackChannels() {
  const channels = [];
  let cursor;
  do {
    const page = await slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000, // fewer paginated calls → fewer rate-limit hits
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) return fallbackList('channels', page);
    channels.push(...page.channels.map((c) => ({ id: c.id, name: c.name, isPrivate: !!c.is_private })));
    cursor = page.response_metadata?.next_cursor;
  } while (cursor);
  channels.sort((a, b) => a.name.localeCompare(b.name));
  await cache().update((d) => { d.channels = channels; });
  return { ok: true, channels };
}

// On a failed live fetch (esp. ratelimited), serve the last cached list if we have one.
async function fallbackList(key, failure) {
  const cached = (await cache().read())[key];
  if (cached?.length) return { ok: true, [key]: cached, stale: true };
  return failure;
}

async function listSlackUsers() {
  const users = [];
  let cursor;
  do {
    const page = await slackApi('users.list', { limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!page.ok) return fallbackList('users', page);
    users.push(...page.members
      .filter((u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT')
      .map((u) => ({ id: u.id, name: u.profile?.real_name || u.name })));
    cursor = page.response_metadata?.next_cursor;
  } while (cursor);
  users.sort((a, b) => a.name.localeCompare(b.name));
  await cache().update((d) => { d.users = users; });
  return { ok: true, users };
}

// target: { type: 'channel'|'user', id } — send the EDITED note text (no localhost video links).
async function sendToSlack(target, text) {
  let channelId = target.id;
  if (target.type === 'user') {
    const dm = await slackApi('conversations.open', { users: target.id });
    if (!dm.ok) return dm;
    channelId = dm.channel.id;
  }
  let post = await slackApi('chat.postMessage', { channel: channelId, text, unfurl_links: false });
  if (!post.ok && post.error === 'not_in_channel') {
    const join = await slackApi('conversations.join', { channel: channelId });
    if (!join.ok) return join;
    post = await slackApi('chat.postMessage', { channel: channelId, text, unfurl_links: false });
  }
  return post.ok ? { ok: true } : post;
}

module.exports = { listSlackChannels, listSlackUsers, sendToSlack };
