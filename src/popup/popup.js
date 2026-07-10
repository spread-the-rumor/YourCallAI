import logoUrl from '../renderer/logo.png';

const PLATFORM_LABELS = { 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' };

document.getElementById('popup-logo').src = logoUrl;

window.popup.onMeetingInfo((info) => {
  document.getElementById('detail').textContent =
    `${PLATFORM_LABELS[info.platform] || info.platform} · ${info.title || ''}`;
});

document.getElementById('start').addEventListener('click', () => window.popup.startRecording());
document.getElementById('dismiss').addEventListener('click', () => window.popup.dismiss());
