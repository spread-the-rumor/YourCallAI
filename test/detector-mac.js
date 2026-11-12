// macOS detection: no mic-holder data, so calls are classified by call-window titles.
// node test/detector-mac.js
const assert = require('assert');
const { classifySnapshot, stillLive, createTracker } = require('../src/detector');

const snap = (windows) => ({ mic: [], micUnknown: true, playing: [], windows });

// Zoom's in-call window starts a call; its main window does not.
assert.strictEqual(classifySnapshot(snap([{ proc: 'zoom', title: 'Zoom Workplace' }])), null);
const z = classifySnapshot(snap([{ proc: 'zoom', title: 'Zoom Meeting' }]));
assert.strictEqual(z.platform, 'zoom');
assert.strictEqual(z.known, true);

// Google Meet in a browser tab.
const g = classifySnapshot(snap([{ proc: 'chrome', title: 'Meet – abc-defg-hij' }]));
assert.strictEqual(g.platform, 'google-meet');
assert.strictEqual(g.transport, 'browser');
assert.ok(stillLive(g, snap([{ proc: 'chrome', title: 'Meet – abc-defg-hij' }])), 'tab open = live');
assert.ok(!stillLive(g, snap([{ proc: 'chrome', title: 'Inbox' }])), 'tab gone = over');

// The Teams main window ("Calls" / "Meetings" tabs) never starts a call.
assert.strictEqual(classifySnapshot(snap([{ proc: 'teams', title: 'Calls | Microsoft Teams' }])), null);
assert.strictEqual(classifySnapshot(snap([{ proc: 'safari', title: 'Some article' }])), null);

// With mic data present (Windows) and nobody holding the mic, titles alone still start nothing.
assert.strictEqual(classifySnapshot({ mic: [], windows: [{ proc: 'zoom', title: 'Zoom Meeting' }] }), null);

// The tracker announces a title-only call after the known-app delay.
const t = createTracker();
assert.strictEqual(t.step(0, snap([{ proc: 'zoom', title: 'Zoom Meeting' }])), null);
const evt = t.step(5000, snap([{ proc: 'zoom', title: 'Zoom Meeting' }]));
assert.ok(evt && evt.type === 'detected' && evt.call.platform === 'zoom');

console.log('detector-mac: all assertions passed');
