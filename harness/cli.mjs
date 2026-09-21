import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parse } from 'yaml';
import { BridgeClient } from '../mcp-server/dist/bridge.js';
import { runScenario, assertTarget, validateScenario } from './scenario.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export function parseArgs(argv) {
  const out = { vars: {} };
  const fields = { '--url': 'url', '--token': 'token', '--artifacts': 'artifacts', '--config': 'config' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--doctor') out.doctor = true;
    else if (arg === '--var') {
      const match = argv[++i]?.match(/^([a-zA-Z]\w*)=(.*)$/);
      if (!match) throw new Error('Expected --var name=value');
      out.vars[match[1]] = match[2];
    } else if (fields[arg]) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      out[fields[arg]] = value;
    } else if (arg.startsWith('-') || out.file) throw new Error('Unknown argument: ' + arg);
    else out.file = arg;
  }
  return out;
}
export function loadConfig(file = resolve(HERE, 'config.json')) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  return { ...cfg, sources: resolve(dirname(file), cfg.sources ?? '../../../config/sources.json'), url: process.env.MCPFABRIC_URL || cfg.url || 'http://127.0.0.1:25599' };
}
export function resolveToken(cfg, explicit) {
  if (explicit || process.env.MCPFABRIC_TOKEN) return explicit || process.env.MCPFABRIC_TOKEN;
  const path = process.env.MCPFABRIC_MINECRAFT_CONFIG || cfg.minecraftConfig;
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')).token || '';
  return '';
}
export function consoleCommand(cfg, server, command) {
  const uuid = cfg.servers?.[server];
  if (!uuid || !/^[a-f0-9-]{36}$/i.test(uuid)) throw new Error('Unknown server alias: ' + server);
  if (!cfg.python || /\.(cmd|bat)$/i.test(cfg.python)) throw new Error('config.python must point to the Python executable, not a shell wrapper.');
  if (typeof command !== 'string' || command.length > 8192 || /[\r\n\0]/.test(command)) throw new Error('Console expects one bounded command.');
  return new Promise((resolvePromise, reject) => {
    const child = execFile(cfg.python, ['-B', resolve(HERE, 'panel_cmd.py'), '--sources', cfg.sources], {
      windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1' },
    }, (err, stdout) => {
      if (err) return reject(new Error('Console transport failed: ' + (err.code ?? 'unknown')));
      try { const result = JSON.parse(stdout); if (result.accepted !== true) throw new Error('Console request rejected.'); resolvePromise(result); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ server: uuid, command }));
  });
}
async function doctor(cfg, bridge) {
  let failures = 0;
  async function check(label, run) {
    try { const result = await run(); console.log('ok   ' + label + ' — ' + result); }
    catch (err) { failures++; console.log('FAIL ' + label + ' — ' + err.message); }
  }
  await check('bridge', async () => { const s = await bridge.call('info.status'); if (s.bridgeProtocol !== 2) throw new Error('Restart Minecraft with the protocol 2 mod.'); return s.modVersion; });
  await check('player/target', async () => { const s = await bridge.call('player.getState'); assertTarget(s, cfg); return s.name + ' / ' + s.uuid + ' @ ' + s.serverAddress; });
  await check('Pterodactyl transport', async () => { await consoleCommand(cfg, 'survival', 'list'); return 'request accepted (not command-output verification)'; });
  await bridge.close();
  console.log((failures ? 'FAIL' : 'PASS') + ' — doctor');
  return failures ? 1 : 0;
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cfg = loadConfig(args.config);
  if (args.vars.player) cfg.player = args.vars.player;
  if (cfg.player && !/^[a-zA-Z0-9_]{1,16}$/.test(cfg.player)) throw new Error('Invalid Minecraft player name.');
  if (!args.file && !args.doctor) throw new Error('usage: node runner.mjs <scenario.yaml> or --doctor');
  const scenario = args.file ? validateScenario(parse(readFileSync(resolve(args.file), 'utf8'))) : undefined;
  const bridge = new BridgeClient(args.url || cfg.url, resolveToken(cfg, args.token), 15000);
  if (args.doctor) return doctor(cfg, bridge);
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const report = await runScenario(scenario, { bridge, cfg, artifacts: args.artifacts || resolve(HERE, 'artifacts'), vars: args.vars, signal: abort.signal, consoleCommand: (server, command) => consoleCommand(cfg, server, command) });
    console.log(report.status + ' — ' + scenario.name + (report.error ? ': ' + report.error : ''));
    console.log('report: ' + resolve(report.artifactDirectory, 'report.json'));
    return report.status === 'PASS' ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
