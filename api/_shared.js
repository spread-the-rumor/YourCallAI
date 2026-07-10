// Shared helpers for the Vercel proxy functions. No auth gate for now (URL kept private);
// ponytail: add an app-token header check here if credits get abused — one place gates all routes.

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Read+parse a JSON request body (Vercel Node functions give req.body pre-parsed when
// Content-Type is json, but be defensive for raw streams).
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const env = (k) => process.env[k];

module.exports = { json, readJson, env };
