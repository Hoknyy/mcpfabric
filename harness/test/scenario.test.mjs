import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validateScenario, checkExpectations, substitute, waitForChat, assertTarget, runScenario } from '../scenario.mjs';

const identity = { uuid: '11111111-1111-1111-1111-111111111111', name: 'Tester', serverAddress: 'staging:25565', dimension: 'overworld', x: 2, y: 64, z: 3 };
const cfg = { player: 'Tester', serverAddress: 'staging:25565', disposablePlayerUuids: [] };
const reads = ['info.status', 'player.getState', 'player.getInventory', 'container.read', 'gui.list', 'events.getRecent', 'vision.screenshot'];
const scenario = steps => ({ name: 'regression', steps });
function mock(overrides = {}) {
  const calls = [];
  return {
    calls, closed: false,
    async withControl(fn) { return fn(); },
    async close() { this.closed = true; },
    async call(method, args = {}) {
      calls.push({ method, args });
      if (overrides[method]) return overrides[method](args);
      if (method === 'info.status') return { bridgeProtocol: 2, readOnlyMethods: reads };
      if (method === 'player.getState') return identity;
      if (method === 'events.getRecent') return { events: [], lastId: 10, oldestId: 1, streamId: 'current' };
      if (method === 'vision.screenshot') throw new Error('mock screenshot unavailable');
      return {};
    },
  };
}
async function run(spec, bridge, extra = {}) {
  return runScenario(spec, { bridge, cfg, artifacts: mkdtempSync(resolve(tmpdir(), 'mcp-harness-')), onStep() {}, consoleCommand: async () => ({ accepted: true }), ...extra });
}
test('reject empty, assertion-free, misspelled step, ignored chatContains, mutation retries', () => {
  for (const spec of [scenario([]), scenario([{ log: 'not a test' }]), scenario([{ call: 'player.getState', exepct: { x: 0 } }]), scenario([{ call: 'player.getState', expect: { chatContains: 'ignored' } }]), scenario([{ call: 'container.click', retry: 1, expect: { ok: true } }])]) assert.throws(() => validateScenario(spec));
});
test('typed saved variables and unknown variable rejection', () => {
  assert.deepEqual(substitute({ x: '{{before.x}}', baseline: '{{before}}' }, { before: { x: 4 } }), { x: 4, baseline: { x: 4 } });
  assert.throws(() => substitute('{{missing}}', {}));
  assert.throws(() => substitute('{{__proto__.x}}', {}));
});
test('old chat never proves a current action; new system message does', async () => {
  const cursor = { lastId: 10, streamId: 'current' };
  const bridge = mock({ 'events.getRecent': () => ({ events: [{ id: 2, data: { text: 'success' } }], lastId: 10, oldestId: 1, streamId: 'current' }) });
  await assert.rejects(waitForChat(bridge, 'success', cursor, 0), /No new/);
  assert.equal(bridge.calls[0].args.sinceId, 10);
  assert.deepEqual(bridge.calls[0].args.types, ['system_message']);
  const fresh = mock({ 'events.getRecent': () => ({ events: [{ id: 11, data: { text: 'success' } }], lastId: 11, oldestId: 1, streamId: 'current' }) });
  assert.equal((await waitForChat(fresh, 'success', cursor, 0)).matched.length, 1);
});
test('restart and event buffer overflow cannot produce PASS', async () => {
  for (const snapshot of [{ streamId: 'restart', lastId: 11, oldestId: 1 }, { streamId: 'current', lastId: 9999, oldestId: 100 }]) {
    await assert.rejects(waitForChat(mock({ 'events.getRecent': () => snapshot }), 'success', { lastId: 10, streamId: 'current' }, 0), /restarted or overflowed/);
  }
});
test('home and inventory assertions detect old locations and missing purchase', () => {
  assert.ok(checkExpectations({ ...identity, x: 200 }, { nearPosition: { baseline: identity, tolerance: 2 } }).length);
  assert.deepEqual(checkExpectations(identity, { nearPosition: { baseline: identity } }), []);
  assert.ok(checkExpectations({ hotbar: [] }, { inventoryDelta: { baseline: { hotbar: [] }, id: 'minecraft:wheat', delta: 1 } }).length);
  assert.deepEqual(checkExpectations({ main: [{ id: 'minecraft:wheat', count: 2 }] }, { inventoryDelta: { baseline: { hotbar: [{ id: 'minecraft:wheat', count: 1 }] }, id: 'minecraft:wheat', delta: 1 } }), []);
});
test('wrong account, server, or changed UUID rejected', () => {
  assert.throws(() => assertTarget({ ...identity, name: 'SomeoneElse' }, cfg), /Wrong player/);
  assert.throws(() => assertTarget({ ...identity, serverAddress: 'production' }, cfg), /Wrong server/);
  assert.throws(() => assertTarget({ ...identity, uuid: 'changed' }, cfg, identity), /changed/);
});
test('personal account cannot execute console fixture, even with teardown', async () => {
  let commands = 0;
  const bridge = mock();
  const result = await run({ ...scenario([{ console: { server: 'survival', command: 'clear Tester' } }, { call: 'player.getState', expect: { name: 'Tester' } }]), destructive: true, teardown: [{ console: { server: 'survival', command: 'clear Tester' } }] }, bridge, { consoleCommand: async () => { commands++; } });
  assert.equal(result.status, 'FAIL'); assert.match(result.error, /disposable/); assert.equal(commands, 0); assert.equal(bridge.closed, true);
});
test('failed action is issued once; teardown runs and report retains failure', async () => {
  let writes = 0, cleaned = 0;
  const bridge = mock({ 'chat.send': () => { writes++; throw new Error('action uncertain'); }, 'player.getInventory': () => { cleaned++; return { hotbar: [] }; } });
  const result = await run({ ...scenario([{ call: 'chat.send', args: { message: '/test' } }, { call: 'player.getState', expect: { name: 'Tester' } }]), teardown: [{ call: 'player.getInventory', expect: { hotbar: [] } }] }, bridge);
  assert.equal(result.status, 'FAIL'); assert.equal(writes, 1); assert.equal(cleaned, 1); assert.ok(bridge.closed);
  const saved = JSON.parse(readFileSync(resolve(result.artifactDirectory, 'report.json')));
  assert.equal(saved.steps[0].attempts, 1); assert.equal(saved.teardown[0].ok, true);
});
test('read retries wait for actual state, then click carries observed menu preconditions', async () => {
  let count = 0;
  const bridge = mock({ 'container.read': () => ({ menuId: 7, stateId: 12, title: ++count === 1 ? 'Loading' : 'Shop', items: [] }) });
  const result = await run(scenario([{ call: 'container.read', retry: { timeout: 1, interval: 0.01 }, expect: { title: 'Shop' } }, { call: 'container.click', args: { slot: 10 } }]), bridge);
  assert.equal(result.status, 'PASS'); assert.equal(count, 2);
  assert.deepEqual(bridge.calls.find(c => c.method === 'container.click').args, { slot: 10, expectedMenuId: 7, expectedStateId: 12, expectedTitle: 'Shop' });
});
test('menu cannot be clicked without observing it first', async () => {
  const bridge = mock();
  const result = await run(scenario([{ call: 'container.click', args: { slot: 10 } }, { call: 'player.getState', expect: { name: 'Tester' } }]), bridge);
  assert.equal(result.status, 'FAIL'); assert.equal(bridge.calls.filter(c => c.method === 'container.click').length, 0);
});
test('cleanup failure makes the whole run fail', async () => {
  const result = await run({ ...scenario([{ call: 'player.getState', expect: { name: 'Tester' } }]), teardown: [{ call: 'player.getState', expect: { name: 'wrong' } }] }, mock());
  assert.equal(result.status, 'FAIL'); assert.match(result.cleanupError, /Mismatch/);
});

test('console log annotations preserve setup and teardown execution', async () => {
  const commands = [];
  const result = await run({ ...scenario([
    { console: { server: 'survival', command: 'fixture setup' }, log: 'Set up fixture' },
    { call: 'player.getState', expect: { name: 'Tester' } },
  ]), destructive: true, teardown: [{ console: { server: 'survival', command: 'fixture cleanup' }, log: 'Clean up fixture' }] }, mock(), {
    cfg: { ...cfg, disposablePlayerUuids: [identity.uuid] },
    consoleCommand: async (server, command) => { commands.push([server, command]); return { accepted: true }; },
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(commands, [['survival', 'fixture setup'], ['survival', 'fixture cleanup']]);
});
