'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBg } = require('./helpers/load-bg.js');

// Loads after-engine.js over a stub `AgentHandlers` (the engine's command table) and a
// recording `chrome`. setTimeout is captured, never scheduled.
function loadAfter(agentHandlers) {
  const calls = { storageSet: [], tabsCreate: [], tabsUpdate: [], windowsCreate: [], timers: [] };
  const chrome = {
    storage: { local: { set(v) { calls.storageSet.push(v); } } },
    tabs: { create(p) { calls.tabsCreate.push(p); }, update(...a) { calls.tabsUpdate.push(a); } },
    windows: { create(p) { calls.windowsCreate.push(p); } },
    runtime: { getPlatformInfo(cb) { cb({ os: 'win' }); } },
  };
  const extras = { chrome, setTimeout(fn, ms) { calls.timers.push({ fn, ms }); return calls.timers.length; } };
  if (agentHandlers) extras.AgentHandlers = agentHandlers;
  const { sandbox, logs } = loadBg('after-engine.js', extras);
  return { sandbox, logs, chrome, calls };
}

test('pairing bypass strips the display code from authNew and marks the welcome page shown', () => {
  const seen = [];
  const AH = { authNew(a) { seen.push(a); return 'ok'; } };
  const { calls } = loadAfter(AH);
  assert.equal(AH.authNew({ code: '123456', extId: 'x' }), 'ok');
  assert.deepEqual(seen, [{ extId: 'x' }]);
  AH.authNew({ extId: 'y' });
  assert.deepEqual(seen[1], { extId: 'y' });
  assert.deepEqual(structuredClone(calls.storageSet), [{ welcomeScreenShown: 1 }]);   // the record was created inside the vm context
});

test('without AgentHandlers the bypass warns and nothing throws', () => {
  const { logs } = loadAfter(undefined);
  assert.ok(logs.some((l) => l.level === 'warn' && l.text.includes('pairing bypass inactive')));
});

test('keep-alive schedules its first ping at 20 s and re-arms after each ping', () => {
  const { calls } = loadAfter({ authNew() {} });
  const pings = () => calls.timers.filter((t) => t.ms === 20000);
  assert.equal(pings().length, 1);
  pings()[0].fn();
  assert.equal(pings().length, 2);
});
