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
test('a redrawn menu is read again and clicked only for the expected item or the very same slot item', async () => {
  const stale = () => Object.assign(new Error('Container contents changed; read it again.'), { code: 'stale_menu' });
  const paper = name => [{ slot: 10, id: 'minecraft:paper', name, count: 1 }];
  for (const [args, menuAfter, itemAfter, wantStatus, wantClicks] of [
    [{ slot: 10, expectedItemName: 'Blocs' }, 7, 'Blocs', 'PASS', 2],
    [{ slot: 10 }, 7, 'Blocs', 'PASS', 2],
    [{ slot: 10 }, 7, 'Visites', 'FAIL', 1],
    [{ slot: 10, expectedItemId: 'minecraft:paper' }, 8, 'Blocs', 'FAIL', 1],
  ]) {
    let state = 12, reads = 0;
    const clicked = [];
    const bridge = mock({
      'container.read': () => (reads++ === 0
        ? { menuId: 7, stateId: state++, title: 'Shop', items: paper('Blocs') }
        : { menuId: menuAfter, stateId: state++, title: 'Shop', items: paper(itemAfter) }),
      'container.click': a => { clicked.push(a.expectedStateId); if (clicked.length === 1) throw stale(); return { ok: true }; },
    });
    const result = await run(scenario([{ call: 'container.read', expect: { title: 'Shop' } }, { call: 'container.click', args }]), bridge);
    assert.equal(result.status, wantStatus); assert.equal(clicked.length, wantClicks);
    if (wantClicks === 2) { assert.deepEqual(clicked, [12, 13]); assert.equal(result.steps[1].staleRetries, 1); }
  }
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

test('SNBT comparison ignores compound key order but not values, lists or types', async () => {
  const { canonicalSnbt } = await import('../scenario.mjs');
  const spawn = '{Slot: 0b, id: "minecraft:netherite_pickaxe", count: 1, components: {"minecraft:lore": [{italic: 0b, text: "S-05", color: "gray"}], "minecraft:enchantments": {"minecraft:fortune": 3, "minecraft:efficiency": 5}, "minecraft:custom_name": {italic: 0b, text: "A5 Pioche"}, "minecraft:damage": 123}}';
  const shard = '{Slot: 0b, id: "minecraft:netherite_pickaxe", count: 1, components: {"minecraft:lore": [{italic: 0b, text: "S-05", color: "gray"}], "minecraft:custom_name": {italic: 0b, text: "A5 Pioche"}, "minecraft:enchantments": {"minecraft:efficiency": 5, "minecraft:fortune": 3}, "minecraft:damage": 123}}';
  assert.equal(canonicalSnbt(spawn), canonicalSnbt(shard));
  const at = text => ({ messages: [{ data: { text } }] });
  assert.deepEqual(checkExpectations(at(shard), { snbtEquals: { 'messages.0.data.text': spawn } }), []);
  for (const changed of [
    shard.replace('"minecraft:damage": 123', '"minecraft:damage": 124'),
    shard.replace('"minecraft:fortune": 3', '"minecraft:fortune": 3s'),
    shard.replace('[{italic: 0b, text: "S-05", color: "gray"}]', '[]'),
    shard.replace(', "minecraft:damage": 123', ''),
    'not snbt {',
  ]) assert.ok(checkExpectations(at(changed), { snbtEquals: { 'messages.0.data.text': spawn } }).length, changed);
  assert.notEqual(canonicalSnbt('[{a: 1}, {b: 2}]'), canonicalSnbt('[{b: 2}, {a: 1}]'));
  assert.equal(canonicalSnbt('{s: "a\\"b"}'), canonicalSnbt("{s: 'a\"b'}"));
  assert.throws(() => canonicalSnbt('{a: 1, a: 2}'));
});

test('reconnect: join needs no world but only reaches the configured address, then identity is re-checked', async () => {
  let inWorld = true;
  const state = () => { if (!inWorld) throw new Error('Not in world'); return identity; };
  const bridge = mock({ 'player.getState': state, 'connection.disconnect': () => { inWorld = false; return { disconnected: true }; }, 'connection.join': () => { inWorld = true; return { connecting: true }; } });
  const journey = scenario([
    { call: 'connection.disconnect' },
    { call: 'connection.join', args: { address: 'staging:25565' } },
    { call: 'player.getState', retry: 2, expect: { name: 'Tester' } },
  ]);
  assert.equal((await run(journey, bridge)).status, 'PASS');
  const joinAt = bridge.calls.findIndex(c => c.method === 'connection.join');
  assert.notEqual(bridge.calls[joinAt - 1].method, 'player.getState');
  inWorld = false;
  const elsewhere = mock({ 'player.getState': state });
  const refused = await run(scenario([{ call: 'connection.join', args: { address: 'evil:25565' } }, { call: 'player.getState', expect: { name: 'Tester' } }]), elsewhere);
  assert.equal(refused.status, 'FAIL');
  assert.ok(!elsewhere.calls.some(c => c.method === 'connection.join'));
});

test('tab list: includes/excludes match partial entries and fail closed on a missing list or empty entry', () => {
  const tab = { header: 'Khraal', players: [
    { uuid: '11111111-1111-1111-1111-111111111111', name: 'Tester', listed: true },
    { uuid: '22222222-2222-2222-2222-222222222222', name: 'Tikifirst', listed: false },
  ] };
  assert.deepEqual(checkExpectations(tab, { includes: { players: { name: 'tester', listed: true } }, excludes: { players: { name: 'Tikifirst', listed: true } } }), []);
  assert.ok(checkExpectations(tab, { excludes: { players: { name: 'TIKIFIRST' } } }).length, 'an unlisted entry is still present');
  assert.ok(checkExpectations(tab, { includes: { players: { name: 'Tikifirst', listed: true } } }).length);
  assert.deepEqual(checkExpectations(tab, { excludes: { players: [{ name: 'Ghost' }, { uuid: '33333333-3333-3333-3333-333333333333' }] } }), []);
  for (const bad of [{ excludes: { player: { name: 'Ghost' } } }, { excludes: { players: {} } }, { excludes: { players: [] } }, { includes: { header: { name: 'Tester' } } }]) {
    assert.ok(checkExpectations(tab, bad).length, JSON.stringify(bad));
  }
});

test('players.tabList is a read: retried until the player leaves the tab, without an action cursor', async () => {
  const spec = scenario([{ call: 'players.tabList', retry: { timeout: 1, interval: 0.01 }, expect: { includes: { players: { name: '{{player}}', listed: true } }, excludes: { players: { name: 'Tikifirst', listed: true } } } }]);
  validateScenario(spec);
  let refresh = 0;
  const bridge = mock({
    'info.status': () => ({ bridgeProtocol: 2, readOnlyMethods: [...reads, 'players.tabList'] }),
    'players.tabList': () => ({ players: [{ name: 'Tester', listed: true }, ...(++refresh < 3 ? [{ name: 'Tikifirst', listed: true }] : [])] }),
  });
  const result = await run(spec, bridge);
  assert.equal(result.status, 'PASS'); assert.equal(refresh, 3);
  assert.ok(!bridge.calls.some(c => c.method === 'events.getRecent'), 'a read must not be handled as an action');
});
