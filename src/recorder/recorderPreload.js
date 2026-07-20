const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  sendChunk: (rec, buf) => ipcRenderer.send('capture-chunk', { rec, buf }),
  stopped: () => ipcRenderer.send('capture-stopped'),
  error: (message) => ipcRenderer.send('capture-error', message),
  audio: (active) => ipcRenderer.send('capture-audio', active), // liveness heartbeat
  silence: () => ipcRenderer.send('capture-silence'),           // 30s of no speech
  onStart: (cb) => ipcRenderer.on('start-capture', () => cb()),
  onStop: (cb) => ipcRenderer.on('stop-capture', () => cb()),
});
