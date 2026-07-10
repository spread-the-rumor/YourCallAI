const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  sendChunk: (rec, buf) => ipcRenderer.send('capture-chunk', { rec, buf }),
  stopped: () => ipcRenderer.send('capture-stopped'),
  error: (message) => ipcRenderer.send('capture-error', message),
  onStart: (cb) => ipcRenderer.on('start-capture', () => cb()),
  onStop: (cb) => ipcRenderer.on('stop-capture', () => cb()),
});
