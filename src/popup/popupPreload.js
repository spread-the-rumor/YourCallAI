const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  startRecording: () => ipcRenderer.send('popup-start-recording'),
  stopRecording: () => ipcRenderer.send('popup-stop-recording'),
  keepRecording: () => ipcRenderer.send('popup-keep-recording'),
  dismiss: () => ipcRenderer.send('popup-dismiss'),
  onShow: (cb) => ipcRenderer.on('popup-show', (e, info) => cb(info)),
});
