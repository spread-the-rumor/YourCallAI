const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  startRecording: () => ipcRenderer.send('popup-start-recording'),
  dismiss: () => ipcRenderer.send('popup-dismiss'),
  onMeetingInfo: (cb) => ipcRenderer.on('meeting-info', (e, info) => cb(info)),
});
