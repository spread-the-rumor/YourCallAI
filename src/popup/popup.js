import logoUrl from '../renderer/logo.png';

const PLATFORM_LABELS = {
  'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', slack: 'Slack huddle',
  webex: 'Webex', ringcentral: 'RingCentral', goto: 'GoTo Meeting', discord: 'Discord',
  skype: 'Skype', whatsapp: 'WhatsApp', telegram: 'Telegram', browser: 'Browser call', other: 'Call',
};

document.getElementById('popup-logo').src = logoUrl;

const $ = (id) => document.getElementById(id);
const titleEl = $('title');
const detailEl = $('detail');
const btn = { start: $('start'), dismiss: $('dismiss'), stop: $('stop'), keep: $('keep'), keepEnding: $('keep-ending'), captureOk: $('capture-ok') };

let countdownTimer = null;
const stopCountdown = () => { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } };

// info = { kind: 'detected' | 'silence' | 'ending' | 'capture-degraded' | 'capture-endpoint-switched',
//          platform, title, seconds, deviceName }
window.popup.onShow((info) => {
  stopCountdown();
  const kind = info.kind || 'detected';
  const label = PLATFORM_LABELS[info.platform] || info.platform || '';

  // Show only the buttons for this mode.
  btn.start.classList.toggle('hidden', kind !== 'detected');
  btn.dismiss.classList.toggle('hidden', kind !== 'detected');
  const ackOnly = ['capture-degraded', 'capture-endpoint-switched', 'recording-ended'].includes(kind);
  btn.stop.classList.toggle('hidden', kind !== 'silence' && kind !== 'meeting-over');
  btn.keep.classList.toggle('hidden', kind !== 'silence' && kind !== 'meeting-over');
  btn.keepEnding.classList.toggle('hidden', kind !== 'ending');
  btn.captureOk.classList.toggle('hidden', !ackOnly);
  detailEl.classList.toggle('wrap', ackOnly || kind === 'meeting-over');

  if (kind === 'recording-ended') {
    // Capture ended without the user pressing Stop. What was captured is kept and transcribed.
    titleEl.textContent = 'Recording ended early';
    detailEl.textContent = `${info.detail ? info.detail.charAt(0).toUpperCase() + info.detail.slice(1) + '. ' : ''}What was captured is saved and being transcribed.`;
  } else if (kind === 'meeting-over') {
    // Manually started recordings are never stopped automatically — ask instead.
    titleEl.textContent = 'Meeting seems to be over';
    detailEl.textContent = `${label ? label + ' is no longer in a call. ' : 'The call app is no longer in a call. '}Stop recording?`;
  } else if (kind === 'detected') {
    titleEl.textContent = 'Meeting detected';
    detailEl.textContent = `${label}${info.title ? ' · ' + info.title : ''}`;
  } else if (kind === 'silence') {
    titleEl.textContent = 'No one’s spoken for 30s';
    detailEl.textContent = 'Stop recording?';
  } else if (kind === 'capture-degraded') {
    // Warn only — recording continues. A half-captured meeting still transcribes; a stopped
    // one is gone. The Bluetooth hint is added only when it is actually relevant.
    titleEl.textContent = info.videoDead && info.reason === 'display-changed' ? 'Screen video stopped after a display change'
      : info.videoDead ? 'Screen video isn’t being recorded'
      : info.micDead && info.sysDead ? 'No audio is being captured'
        : info.sysDead ? 'Meeting audio isn’t being captured'
          : 'Your mic isn’t being captured';
    detailEl.textContent = info.videoDead
      ? 'Still recording. Audio, transcript and summary are unaffected — only the video is missing.'
      // Naming the endpoint is the difference between a message the user can act on and one they
      // can only dismiss: Windows is pointed at this device and nothing is playing to it.
      : info.reason === 'no-live-endpoint' && info.deviceName
        ? `Still recording. Windows is set to “${info.deviceName}” but nothing is playing there — switch your output to the device you can hear the meeting on.`
        : info.sysDead && info.bluetooth
          ? 'Still recording. Your output is a Bluetooth headset — try switching the meeting’s speaker to your laptop.'
          : 'Still recording — check your audio device.';
  } else if (kind === 'capture-endpoint-switched') {
    // We changed the Windows default output. That is a system-wide change the user did not make,
    // and it is deliberately NOT restored afterwards, so say so plainly rather than burying it.
    titleEl.textContent = 'Meeting audio recovered';
    detailEl.textContent = `Switched Windows output to “${info.deviceName}” so the meeting is captured. Still recording — this stays selected after the meeting.`;
  } else if (kind === 'ending') {
    titleEl.textContent = 'Meeting ended';
    let remaining = info.seconds || 15;
    const tick = () => { detailEl.textContent = `Stopping in ${remaining}s…`; };
    tick();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { stopCountdown(); return; } // main fires the actual stop on its own timer
      tick();
    }, 1000);
  }
});

btn.start.addEventListener('click', () => window.popup.startRecording());
btn.dismiss.addEventListener('click', () => { stopCountdown(); window.popup.dismiss(); });
btn.stop.addEventListener('click', () => { stopCountdown(); window.popup.stopRecording(); });
btn.keep.addEventListener('click', () => { stopCountdown(); window.popup.keepRecording(); });
btn.keepEnding.addEventListener('click', () => { stopCountdown(); window.popup.keepRecording(); });
// Acknowledge-only: capture is degraded, not stopped, so this just dismisses the warning.
btn.captureOk.addEventListener('click', () => { stopCountdown(); window.popup.dismiss(); });
