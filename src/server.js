// In-process backend (§3.3): Express on 127.0.0.1:3100 serving recorded media.
// express.static handles HTTP Range, so playback/seek and downloads work.
// Never throws — EADDRINUSE resolves gracefully to null.
const express = require('express');

const PORT = 3100; // webpack dev server owns 3000 — never use it

function start(recordingsDir) {
  return new Promise((resolve) => {
    try {
      const app = express();
      app.use('/recordings', express.static(recordingsDir));
      app.get('/health', (req, res) => res.json({ ok: true }));
      const srv = app.listen(PORT, '127.0.0.1', () => resolve(srv));
      srv.on('error', (err) => {
        console.error(`[server] failed to bind :${PORT} (${err.code}) — media serving disabled`);
        resolve(null);
      });
    } catch (err) {
      console.error('[server] start failed:', err.message);
      resolve(null);
    }
  });
}

module.exports = { start, PORT };
