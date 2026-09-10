import logoUrl from '../renderer/logo.png';

const PLATFORM_LABELS = { 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' };

document.getElementById('popup-logo').src = logoUrl;

const $ = (id) => document.getElementById(id);
const titleEl = $('title');
const detailEl = $('detail');
const btn = { start: $('start'), dismiss: $('dismiss'), stop: $('stop'), keep: $('keep'), keepEnding: $('keep-ending'), captureOk: $('capture-ok') };

let countdownTimer = null;
const stopCountdown = () => { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } };

// info = { kind: 'detected' | 'silence' | 'ending' | 'capture-degraded', platform, title, seconds }
window.popup.onShow((info) => {
  stopCountdown();
  const kind = info.kind || 'detected';
  const label = PLATFORM_LABELS[info.platform] || info.platform || '';

  // Show only the buttons for this mode.
  btn.start.classList.toggle('hidden', kind !== 'detected');
  btn.dismiss.classList.toggle('hidden', kind !== 'detected');
  btn.stop.classList.toggle('hidden', kind !== 'silence');
  btn.keep.classList.toggle('hidden', kind !== 'silence');
  btn.keepEnding.classList.toggle('hidden', kind !== 'ending');
  btn.captureOk.classList.toggle('hidden', kind !== 'capture-degraded');
  detailEl.classList.toggle('wrap', kind === 'capture-degraded');

  if (kind === 'detected') {
    titleEl.textContent = 'Meeting detected';
    detailEl.textContent = `${label}${info.title ? ' · ' + info.title : ''}`;
  } else if (kind === 'silence') {
    titleEl.textContent = 'No one’s spoken for 30s';
    detailEl.textContent = 'Stop recording?';
  } else if (kind === 'capture-degraded') {
    // Warn only — recording continues. A half-captured meeting still transcribes; a stopped
    // one is gone. The Bluetooth hint is added only when it is actually relevant.
    titleEl.textContent = info.videoDead ? 'Screen video isn’t being recorded'
      : info.micDead && info.sysDead ? 'No audio is being captured'
        : info.sysDead ? 'Meeting audio isn’t being captured'
          : 'Your mic isn’t being captured';
    detailEl.textContent = info.videoDead
      ? 'Still recording. Audio, transcript and summary are unaffected — only the video is missing.'
      : info.sysDead && info.bluetooth
        ? 'Still recording. Your output is a Bluetooth headset — try switching the meeting’s speaker to your laptop.'
        : 'Still recording — check your audio device.';
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
