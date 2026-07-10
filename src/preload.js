// Main-window preload: the exact API surface from §10.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => ipcRenderer.on(channel, (e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  onStatus: on('status'),
  onRecordingComplete: on('recording-complete'),
  onTranscribeProgress: on('transcribe-progress'),

  listMeetings: invoke('list-meetings'),
  updateMeeting: invoke('update-meeting'),
  deleteMeeting: invoke('delete-meeting'),
  listTrash: invoke('list-trash'),
  restoreMeeting: invoke('restore-meeting'),
  deleteMeetingPermanent: invoke('delete-meeting-permanent'),

  askMeeting: invoke('ask-meeting'),
  regenerateSummary: invoke('regenerate-summary'),
  retryTranscription: invoke('retry-transcription'),

  startHuddle: invoke('start-huddle'),
  stopRecording: invoke('stop-recording'),
  startDetectedRecording: invoke('start-detected-recording'),
  dismissDetectedMeeting: invoke('dismiss-detected-meeting'),

  sendToSlack: invoke('send-to-slack'),
  listSlackChannels: invoke('list-slack-channels'),
  listSlackUsers: invoke('list-slack-users'),
  listGetOverviewProjects: invoke('list-getoverview-projects'),
  createGetOverviewTask: invoke('create-getoverview-task'),
  sendGetOverviewTranscript: invoke('send-getoverview-transcript'),
  extractActionItems: invoke('extract-action-items'),

  saveTranscript: invoke('save-transcript'),
  saveRecording: invoke('save-recording'),
  renameSpeaker: invoke('rename-speaker'),

  getSettings: invoke('get-settings'),
  saveSettings: invoke('save-settings'),
  getEffectiveConfig: invoke('get-effective-config'),
  getAppVersion: invoke('get-app-version'),
  restartApp: invoke('restart-app'),
});
