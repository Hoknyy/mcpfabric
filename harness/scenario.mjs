import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const STEP_KEYS = new Set(['call', 'args', 'expect', 'expect_chat', 'console', 'wait', 'log', 'retry', 'timeout', 'interval', 'optional', 'save', 'screenshot', 'when']);
const SAFE_READS = new Set(['info.status', 'info.capabilities', 'player.getState', 'player.getInventory', 'player.getEquipment', 'player.getStatusEffects', 'container.read', 'gui.list', 'chat.getRecent', 'events.getRecent', 'vision.screenshot', 'vision.describeScene', 'nav.status', 'control.status', 'connection.status']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);

export function getPath(value, path) {
  for (const part of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Forbidden variable path.');
    value = value?.[part];
  }
  return value;
}
export function substitute(value, vars) {
  if (typeof value === 'string') {
    const lookup = path => { const found = getPath(vars, path); if (found === undefined) throw new Error('Unknown variable: ' + path); return found; };
    const exact = value.match(/^\{\{([\w.]+)\}\}$/);
    if (exact) return structuredClone(lookup(exact[1]));
    return value.replace(/\{\{([\w.]+)\}\}/g, (_, path) => {
      const found = lookup(path); if (object(found) || Array.isArray(found)) throw new Error('Use a complete variable expression for objects.');
      return String(found);
    });
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, vars));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}
export function validateScenario(scenario, reads = SAFE_READS) {
  if (!object(scenario) || !/^[a-zA-Z0-9_-]+$/.test(scenario.name ?? '')) throw new Error('A safe scenario name is required.');
  const allowed = new Set(['name', 'description', 'vars', 'steps', 'teardown', 'destructive', 'continueOnError']);
  for (const key of Object.keys(scenario)) if (!allowed.has(key)) throw new Error('Unknown scenario field: ' + key);
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new Error('Scenario must contain test steps.');
  if (scenario.teardown !== undefined && !Array.isArray(scenario.teardown)) throw new Error('teardown must be an array.');
  let assertions = 0;
  for (const [i, step] of [...scenario.steps, ...(scenario.teardown ?? [])].entries()) {
    if (!object(step)) throw new Error('Invalid step ' + i);
    for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) throw new Error('Unknown step field: ' + key);
    const operations = ['call', 'expect_chat', 'console', 'wait'].filter(k => step[k] !== undefined);
    if (operations.length !== 1 && !(operations.length === 0 && typeof step.log === 'string')) throw new Error('Each step needs exactly one operation.');
    if (step.call !== undefined && (typeof step.call !== 'string' || step.call.startsWith('control.'))) throw new Error('Control lifecycle is managed by the runner.');
    if (step.args !== undefined && (!step.call || !object(step.args))) throw new Error('args requires a call and an object.');
    if (step.retry !== undefined) {
      if (!reads.has(step.call)) throw new Error('retry is allowed only on read-only calls; never repeat an action.');
      const timeout = typeof step.retry === 'number' ? step.retry : step.retry?.timeout;
      const interval = typeof step.retry === 'object' ? step.retry.interval ?? 0.4 : 0.4;
      if (!finite(timeout) || timeout <= 0 || timeout > 120 || !finite(interval) || interval <= 0 || interval > 30) throw new Error('Invalid retry bounds.');
    }
    for (const key of ['wait', 'timeout', 'interval']) if (step[key] !== undefined && (!finite(step[key]) || step[key] < 0 || step[key] > 120)) throw new Error('Invalid ' + key);
    if (step.optional !== undefined && (step.optional !== true || step.call !== 'gui.close')) throw new Error('Only gui.close with no open screen may be optional.');
    if (step.console && (!object(step.console) || typeof step.console.server !== 'string' || typeof step.console.command !== 'string' || scenario.destructive !== true)) throw new Error('Console fixtures require destructive: true and a disposable account.');
    if (step.expect_chat !== undefined && !([step.expect_chat].flat().every(x => typeof x === 'string' && x.length > 0))) throw new Error('expect_chat needs nonempty strings.');
    if (step.expect !== undefined) {
      if (!step.call || !object(step.expect) || Object.keys(step.expect).length === 0) throw new Error('expect requires a call and nonempty assertions.');
      if ('chatContains' in step.expect) throw new Error('Unsupported chatContains: use expect_chat after the action.');
      assertions++;
    }
    if (step.expect_chat !== undefined) assertions++;
    if (step.save && !/^[a-zA-Z][\w]*$/.test(step.save)) throw new Error('Invalid save variable.');
    if (step.when && !/^[a-zA-Z][\w]*$/.test(step.when)) throw new Error('when must name a saved variable.');
  }
  if (!assertions) throw new Error('A test scenario needs at least one assertion.');
  if (scenario.destructive === true && !scenario.teardown?.length) throw new Error('Destructive scenarios require teardown.');
  return scenario;
}

// Canonical SNBT: compound keys sorted, whitespace dropped. Minecraft prints compounds in
// hash-map order, which may differ between servers for the same data.
export function canonicalSnbt(text) {
  const s = String(text);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const invalid = () => { throw new Error('Invalid SNBT at ' + i); };
  const quoted = () => {
    const quote = s[i++];
    let out = '';
    while (i < s.length && s[i] !== quote) out += s[i] === '\\' ? s[(i += 2) - 1] : s[i++];
    if (s[i++] !== quote) invalid();
    return out;
  };
  const bare = () => {
    const start = i;
    while (i < s.length && /[0-9A-Za-z_\-.+]/.test(s[i])) i++;
    if (start === i) invalid();
    return s.slice(start, i);
  };
  const value = () => {
    ws();
    if (s[i] === '{') {
      i++; ws();
      const entries = [];
      if (s[i] === '}') { i++; return '{}'; }
      for (;;) {
        ws();
        const key = s[i] === '"' || s[i] === "'" ? quoted() : bare();
        ws(); if (s[i++] !== ':') invalid();
        entries.push([key, value()]);
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i++] === '}') break;
        invalid();
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (entries.some(([key], n) => n && key === entries[n - 1][0])) invalid();
      return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}';
    }
    if (s[i] === '[') {
      i++; ws();
      let prefix = '';
      if (/[BIL]/.test(s[i]) && s[i + 1] === ';') { prefix = s[i] + ';'; i += 2; }
      const items = [];
      ws();
      if (s[i] === ']') { i++; return '[' + prefix + ']'; }
      for (;;) {
        items.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i++] === ']') break;
        invalid();
      }
      return '[' + prefix + items.join(',') + ']';
    }
    if (s[i] === '"' || s[i] === "'") return JSON.stringify(quoted());
    return bare();
  };
  const out = value();
  ws();
  if (i !== s.length) invalid();
  return out;
}

function itemCount(inv, id) { return [...(inv?.hotbar ?? []), ...(inv?.main ?? []), ...(inv?.armor ?? []), inv?.offhand].filter(Boolean).reduce((n, item) => n + (item.id === id ? item.count : 0), 0); }
export function checkExpectations(result, expect) {
  const failures = [];
  const fail = (ok, message) => { if (!ok) failures.push(message); };
  for (const [key, want] of Object.entries(expect ?? {})) {
    if (key === 'itemAt' || key === 'loreContains') {
      for (const [slot, spec] of Object.entries(want)) {
        const item = result?.items?.find(i => String(i.slot) === slot);
        if (key === 'loreContains') fail(item?.lore?.some(line => line.includes(spec)), 'Missing lore at slot ' + slot + ': ' + spec);
        else for (const [field, value] of Object.entries(spec)) fail(isDeepStrictEqual(item?.[field], value), 'Unexpected item at slot ' + slot + '.' + field);
      }
    } else if (key === 'contains' || key === 'gte' || key === 'lte') {
      for (const [path, value] of Object.entries(want)) {
        const got = getPath(result, path);
        fail(key === 'contains' ? typeof got === 'string' && typeof value === 'string' && got.includes(value) : finite(got) && finite(value) && (key === 'gte' ? got >= value : got <= value), 'Failed ' + key + ': ' + path);
      }
    } else if (key === 'snbtEquals') {
      for (const [path, value] of Object.entries(want)) {
        let same = false;
        try { same = canonicalSnbt(getPath(result, path)) === canonicalSnbt(value); } catch { same = false; }
        fail(same, 'SNBT differs at ' + path);
      }
    } else if (key === 'nearPosition') {
      const { baseline, tolerance = 1 } = want;
      fail(object(baseline) && finite(tolerance) && tolerance >= 0 && result?.dimension === baseline.dimension && ['x', 'y', 'z'].every(k => finite(result?.[k]) && finite(baseline[k]) && Math.abs(result[k] - baseline[k]) <= tolerance), 'Position differs from saved destination.');
    } else if (key === 'inventoryCount') {
      for (const [id, count] of Object.entries(want)) fail(finite(count) && itemCount(result, id) === count, 'Unexpected count for ' + id);
    } else if (key === 'inventoryDelta') {
      fail(object(want.baseline) && finite(want.delta) && itemCount(result, want.id) - itemCount(want.baseline, want.id) === want.delta, 'Unexpected inventory delta for ' + want.id);
    } else if (key === 'chatContains') throw new Error('Unsupported chatContains');
    else fail(isDeepStrictEqual(getPath(result, key), want), 'Mismatch at ' + key + ': expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(getPath(result, key)));
  }
  return failures;
}

export function assertTarget(state, cfg, bound) {
  if (!state?.uuid || !state.name || !state.serverAddress) throw new Error('Bridge must expose the actual player identity and server.');
  if (!cfg.serverAddress || state.serverAddress.toLowerCase() !== cfg.serverAddress.toLowerCase()) throw new Error('Wrong server: refusing mutations.');
  if (cfg.player && state.name.toLowerCase() !== cfg.player.toLowerCase()) throw new Error('Wrong player: refusing mutations.');
  if (bound && (state.uuid !== bound.uuid || state.serverAddress !== bound.serverAddress)) throw new Error('Client identity/connection changed during the run.');
}
export async function waitForChat(bridge, needles, cursor, timeout = 6, interval = 0.2) {
  if (!cursor) throw new Error('expect_chat requires a preceding action and its event cursor.');
  const deadline = Date.now() + timeout * 1000;
  const remaining = new Set([needles].flat());
  const matched = [];
  do {
    const snapshot = await bridge.call('events.getRecent', { sinceId: cursor.lastId, limit: 2000, types: ['system_message'] });
    if (snapshot.streamId !== cursor.streamId || snapshot.lastId < cursor.lastId || snapshot.oldestId > cursor.lastId + 1) throw new Error('Event stream restarted or overflowed; outcome cannot be proven.');
    for (const event of snapshot.events ?? []) if (event.id > cursor.lastId) {
      for (const needle of remaining) if (event.data?.text?.includes(needle)) { matched.push(event); remaining.delete(needle); }
    }
    if (remaining.size === 0) return { matched };
    if (Date.now() >= deadline) break;
    await sleep(Math.max(10, interval * 1000));
  } while (true);
  throw new Error('No new system message matched: ' + [...remaining].join(', '));
}

export async function runScenario(scenario, { bridge, cfg, artifacts, vars: supplied = {}, consoleCommand, onStep = console.log, signal }) {
  validateScenario(scenario);
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const vars = { ...(scenario.vars ?? {}), ...supplied, player: supplied.player ?? cfg.player, runId };
  const report = { name: scenario.name, runId, startedAt: new Date().toISOString(), status: 'FAIL', steps: [], teardown: [] };
  const dir = resolve(artifacts, scenario.name, runId);
  mkdirSync(dir, { recursive: true });
  let reads, bound, cursor, lastContainer, setupStarted = false;
  async function checkTarget() {
    const state = await bridge.call('player.getState');
    assertTarget(state, { ...cfg, player: vars.player }, bound);
    return state;
  }
  async function screenshot(label) {
    try { const shot = await bridge.call('vision.screenshot'); writeFileSync(resolve(dir, label + '.png'), Buffer.from(shot.base64, 'base64')); }
    catch (err) { report.screenshotError = err.message; }
  }
  async function step(raw, phase, index) {
    if (raw.when && !vars[raw.when]) { report[phase].push({ skipped: true, when: raw.when }); return; }
    const step = substitute(raw, vars);
    const label = step.log ?? step.call ?? (step.console ? 'console ' + step.console.server : step.expect_chat ? 'expect_chat' : 'wait');
    const started = Date.now();
    const record = { index, label, ok: false, attempts: 0 };
    report[phase].push(record);
    try {
      if (signal?.aborted && phase === 'steps') throw new Error('Run interrupted.');
      let result;
      if (step.wait !== undefined) await sleep(step.wait * 1000);
      else if (step.expect_chat !== undefined) result = await waitForChat(bridge, step.expect_chat, cursor, step.timeout, step.interval);
      else if (step.log && !step.call && !step.console) { /* annotation only */ }
      else if (step.console) {
        await checkTarget();
        result = await bridge.withControl(async () => { await checkTarget(); return consoleCommand(step.console.server, step.console.command); });
        record.note = 'Transport accepted command; following state assertions must verify its effect.';
      } else {
        const args = { ...(step.args ?? {}) };
        const mutates = !reads.has(step.call);
        if (mutates) {
          // A join happens outside any world: the only precondition is the configured address;
          // the following reads re-bind the identity through checkTarget.
          if (step.call === 'connection.join') {
            if (args.address !== cfg.serverAddress) throw new Error('connection.join is limited to the configured server address.');
          } else await checkTarget();
          if (step.call === 'container.click') {
            if (!lastContainer) throw new Error('Read and assert the container before clicking.');
            Object.assign(args, { expectedMenuId: lastContainer.menuId, expectedStateId: lastContainer.stateId, expectedTitle: lastContainer.title });
          }
          if (step.call.startsWith('gui.')) {
            let screen;
            try { screen = await bridge.call('gui.list'); }
            catch (err) { if (step.optional && err.code === 'bad_request' && err.message === 'No screen is open.') { record.skipped = true; record.ok = true; return; } throw err; }
            Object.assign(args, { expectedScreen: screen.screen, expectedTitle: screen.title });
            if (screen.menuId !== undefined) Object.assign(args, { expectedMenuId: screen.menuId, expectedStateId: screen.stateId });
          }
          cursor = await bridge.call('events.getRecent', { limit: 1 });
          if (typeof cursor.streamId !== 'string' || !Number.isSafeInteger(cursor.lastId)) throw new Error('Bridge event cursor unavailable.');
        }
        const timeout = typeof step.retry === 'number' ? step.retry : step.retry?.timeout ?? 0;
        const interval = typeof step.retry === 'object' ? step.retry.interval ?? 0.4 : 0.4;
        const deadline = Date.now() + timeout * 1000;
        for (;;) {
          try {
            record.attempts++;
            result = await bridge.call(step.call, args);
            const failures = checkExpectations(result, step.expect);
            if (failures.length) throw new Error(failures.join(' | '));
            break;
          } catch (err) {
            if (!reads.has(step.call) || !step.retry || Date.now() >= deadline || signal?.aborted || ['unauthorized', 'upgrade_required'].includes(err.code)) throw err;
            await sleep(interval * 1000);
          }
        }
        if (step.call === 'container.read') lastContainer = result;
        else if (mutates) lastContainer = undefined;
      }
      if (step.save) vars[step.save] = structuredClone(result);
      if (result !== undefined) record.observed = step.call === 'vision.screenshot' ? { width: result.width, height: result.height } : result;
      if (step.screenshot) await screenshot(phase + '-' + index);
      record.ok = true;
    } catch (err) { record.error = err.message; await screenshot('FAIL-' + phase + '-' + index); throw err; }
    finally { record.ms = Date.now() - started; onStep((record.ok ? 'ok ' : 'FAIL ') + label + ' (' + record.ms + 'ms)' + (record.error ? ': ' + record.error : '')); }
  }
  try {
    const status = await bridge.call('info.status');
    if (status.bridgeProtocol !== 2 || !Array.isArray(status.readOnlyMethods)) throw new Error('Upgrade the mod to bridge protocol 2 and restart Minecraft.');
    reads = new Set(status.readOnlyMethods);
    validateScenario(scenario, reads);
    report.bridge = status;
    bound = await checkTarget();
    report.target = { uuid: bound.uuid, name: bound.name, serverAddress: bound.serverAddress };
    if (scenario.destructive && !(cfg.disposablePlayerUuids ?? []).includes(bound.uuid)) throw new Error('Destructive fixtures require a disposable player UUID in config.disposablePlayerUuids. Personal accounts are protected.');
    setupStarted = true;
    for (const [i, raw] of scenario.steps.entries()) {
      try { await step(raw, 'steps', i + 1); }
      catch (err) { if (!scenario.continueOnError) throw err; }
    }
    report.status = report.steps.some(s => s.ok === false) ? 'FAIL' : 'PASS';
  } catch (err) { report.error = err.message; }
  finally {
    if (setupStarted) for (const [i, raw] of (scenario.teardown ?? []).entries()) {
      try { await step(raw, 'teardown', i + 1); }
      catch (err) { report.status = 'FAIL'; report.cleanupError = err.message; break; }
    }
    // Release only this runner's lease; never issue a global stop against another controller.
    try { await bridge.close(); } catch (err) { if (err.code !== 'control_lease_required') { report.status = 'FAIL'; report.releaseError = err.message; } }
    report.finishedAt = new Date().toISOString();
    writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  }
  return { ...report, artifactDirectory: dir };
}
