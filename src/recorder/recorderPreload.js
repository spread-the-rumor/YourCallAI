const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  sendChunk: (rec, buf) => ipcRenderer.send('capture-chunk', { rec, buf }),
  format: (info) => ipcRenderer.send('capture-format', info), // chosen video mime, before the first chunk
  stopped: () => ipcRenderer.send('capture-stopped'),
  error: (message) => ipcRenderer.send('capture-error', message),
  audio: (active) => ipcRenderer.send('capture-audio', active), // liveness heartbeat
  silence: () => ipcRenderer.send('capture-silence'),           // 30s of no speech
  diag: (evt) => ipcRenderer.send('capture-diag', evt),         // → capture.jsonl (diagnostics)
  degraded: (info) => ipcRenderer.send('capture-degraded', info), // a stream is dead; keep recording
  deviceChanged: (info) => ipcRenderer.send('capture-device-changed', info),
  recovered: (info) => ipcRenderer.send('capture-recovered', info), // loopback re-bound, audio back
  onStart: (cb) => ipcRenderer.on('start-capture', (e, opts) => cb(opts || {})),
  onStop: (cb) => ipcRenderer.on('stop-capture', () => cb()),
});
