import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeClient } from '../dist/bridge.js';
import { createHttpServer } from '../dist/http.js';
import { loadConfig } from '../dist/config.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function mockBridge(handle) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    res.setHeader('content-type', 'application/json');
    await handle(input, res, req);
  });
  const port = await listen(server);
  return { server, url: 'http://127.0.0.1:' + port };
}
test('deadline covers delayed response body, not only headers', async () => {
  const { server, url } = await mockBridge((_, res) => { res.writeHead(200); res.flushHeaders(); setTimeout(() => res.end('{"ok":true,"result":{}}'), 300).unref(); });
  try { await assert.rejects(new BridgeClient(url, 'dummy', 40).call('info.status'), /timed out/); }
  finally { await close(server); }
});
test('status rejects auth errors; requests do not follow redirects', async () => {
  let mode = 401;
  const { server, url } = await mockBridge((_, res) => res.writeHead(mode, { Location: 'http://127.0.0.1:1' }).end('{}'));
  try { const bridge = new BridgeClient(url, 'dummy', 200); await assert.rejects(bridge.info(), e => e.code === 'unauthorized'); mode = 302; await assert.rejects(bridge.info()); }
  finally { await close(server); }
});
test('HTTP config fails closed without caller token, stdio remains available', () => {
  assert.equal(loadConfig({}).transport, 'stdio');
  assert.throws(() => loadConfig({ MCPFABRIC_TRANSPORT: 'http' }), /HTTP_TOKEN/);
  assert.throws(() => loadConfig({ MCPFABRIC_HTTP_PORT: '1foo' }));
});
test('HTTP protects all methods/sessions and preserves authorized native tools', async () => {
  const reservation = http.createServer(); const port = await listen(reservation); await close(reservation);
  let effects = 0, sdkClosed = 0, bridgeClosed = 0;
  const cfg = { httpPort: port, httpToken: 'audit-only-client-token' };
  const server = createHttpServer(cfg, () => {
    const mcp = new McpServer({ name: 'test', version: '1' });
    mcp.server.onclose = () => { sdkClosed++; };
    mcp.registerTool('mutate', { inputSchema: {} }, async () => { effects++; return { content: [{ type: 'text', text: 'done' }] }; });
    return { server: mcp, close: async () => { bridgeClosed++; } };
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + cfg.httpToken };
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audit', version: '1' } } };
  async function request(method, extra = {}, body = init) {
    // node:http preserves a deliberately hostile Host header; fetch normalizes it.
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method, headers: { ...headers, ...extra } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, session: res.headers['mcp-session-id'], body: text }));
      });
      req.setTimeout(2000, () => req.destroy(new Error('request timeout'))); req.on('error', reject);
      req.end(method === 'POST' ? JSON.stringify(body) : undefined);
    });
  }
  try {
    assert.equal((await request('POST', { authorization: '' })).status, 401);
    assert.equal((await request('POST', { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request('POST', { host: 'untrusted.invalid' })).status, 403);
    for (const origin of ['https://untrusted.invalid', 'null', 'http://localhost:' + port + '.evil']) assert.equal((await request('POST', { origin })).status, 403);
    const valid = await request('POST'); assert.equal(valid.status, 200); assert.ok(valid.session);
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await request(method, { 'mcp-session-id': valid.session, authorization: '' })).status, 401);
    assert.equal(effects, 0);
    const called = await request('POST', { 'mcp-session-id': valid.session }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mutate', arguments: {} } });
    assert.equal(called.status, 200); assert.equal(effects, 1);
    assert.equal((await request('POST', { 'mcp-session-id': 'unknown' })).status, 404);
    assert.equal((await request('DELETE', { 'mcp-session-id': valid.session })).status, 200);
    assert.equal(sdkClosed, 1); assert.equal(bridgeClosed, 1);
  } finally { await close(server); }
});
test('independent MCP controllers do not share a writer lease; close releases ownership', async () => {
  let owner, next = 0, effects = 0;
  const { server, url } = await mockBridge(({ method, params }, res) => {
    const ok = result => res.end(JSON.stringify({ ok: true, result }));
    const fail = code => res.end(JSON.stringify({ ok: false, error: { code, message: code } }));
    if (method === 'info.status') return ok({ bridgeProtocol: 2, readOnlyMethods: ['info.status'] });
    if (method === 'control.acquire') { if (owner) return fail('control_busy'); owner = 'session-' + (++next); return ok({ sessionId: owner, ttlMs: 10000 }); }
    if (params?._session !== owner) return fail('control_lease_required');
    if (method === 'control.release') { owner = undefined; return ok({}); }
    if (method === 'control.heartbeat') return ok({});
    effects++; return ok({ effects });
  });
  const a = new BridgeClient(url, 'dummy', 500), b = a.fork();
  try {
    assert.equal((await a.call('container.click', { slot: 1 })).effects, 1);
    await assert.rejects(b.call('container.click', { slot: 1 }), e => e.code === 'control_busy');
    assert.equal(effects, 1); await a.close();
    assert.equal((await b.call('container.click', { slot: 1 })).effects, 2);
  } finally { await a.close().catch(() => {}); await b.close().catch(() => {}); await close(server); }
});

for (const mode of ['mutation', 'fixture']) test('close during acquisition prevents late ' + mode + ' and heartbeat', async () => {
  const entered = deferred(), gate = deferred();
  const calls = []; let effects = 0, owner;
  const { server, url } = await mockBridge(async ({ method, params }, res) => {
    calls.push(method);
    const ok = result => res.end(JSON.stringify({ ok: true, result }));
    if (method === 'info.status') return ok({ bridgeProtocol: 2, readOnlyMethods: [] });
    if (method === 'control.acquire') { owner = 'late'; entered.resolve(); await gate.promise; return ok({ sessionId: owner, ttlMs: 600 }); }
    if (method === 'control.release') { assert.equal(params._session, owner); owner = undefined; return ok({}); }
    if (method !== 'control.heartbeat') effects++;
    return ok({});
  });
  const bridge = new BridgeClient(url, 'dummy', 1500);
  try {
    const pending = mode === 'mutation' ? bridge.call('control.setInput') : bridge.withControl(async () => { effects++; });
    const rejected = assert.rejects(pending, e => e.code === 'closed');
    await entered.promise; await bridge.close(); gate.resolve(); await rejected;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(owner, undefined); assert.equal(effects, 0);
    assert.deepEqual(calls.filter(x => x !== 'info.status'), ['control.acquire', 'control.release']);
  } finally { gate.resolve(); await bridge.close().catch(() => {}); await close(server); }
});

test('close during renewal prevents subsequent action and cannot reacquire', async () => {
  const entered = deferred(), gate = deferred();
  let effects = 0, acquisitions = 0, owner;
  const { server, url } = await mockBridge(async ({ method }, res) => {
    const ok = result => res.end(JSON.stringify({ ok: true, result }));
    if (method === 'info.status') return ok({ bridgeProtocol: 2, readOnlyMethods: [] });
    if (method === 'control.acquire') { acquisitions++; owner = 'current'; return ok({ sessionId: owner, ttlMs: 10000 }); }
    if (method === 'control.heartbeat') { entered.resolve(); await gate.promise; return ok({}); }
    if (method === 'control.release') { owner = undefined; return ok({}); }
    effects++; return ok({});
  });
  const bridge = new BridgeClient(url, 'dummy', 1500);
  try {
    await bridge.call('control.setInput');
    const rejected = assert.rejects(bridge.call('control.setInput'), e => e.code === 'closed');
    await entered.promise; await bridge.close(); gate.resolve(); await rejected;
    assert.equal(owner, undefined); assert.equal(effects, 1); assert.equal(acquisitions, 1);
  } finally { gate.resolve(); await bridge.close().catch(() => {}); await close(server); }
});

test('real stdio process releases its lease on stdin EOF before expiry', async () => {
  let owner, releases = 0, effects = 0;
  const { server, url } = await mockBridge(({ method, params }, res) => {
    const ok = result => res.end(JSON.stringify({ ok: true, result }));
    if (!method || method === 'info.status') return ok({ bridgeProtocol: 2, readOnlyMethods: [] });
    if (method === 'control.acquire') { owner = 'stdio-owner'; return ok({ sessionId: owner, ttlMs: 10000 }); }
    assert.equal(params._session, owner);
    if (method === 'control.release') { releases++; owner = undefined; return ok({}); }
    if (method !== 'control.heartbeat') effects++;
    return ok({});
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...getDefaultEnvironment(), MCPFABRIC_URL: url, MCPFABRIC_TOKEN: 'dummy' }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'stdio-lifecycle-test', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'set_movement', arguments: { forward: false } });
    assert.notEqual(result.isError, true); assert.equal(effects, 1); assert.equal(owner, 'stdio-owner');
    await client.close();
    assert.equal(owner, undefined); assert.equal(releases, 1);
  } finally { await client.close().catch(() => {}); await close(server); }
});
