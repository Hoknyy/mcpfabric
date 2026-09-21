import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from './config.js';

/** Local native-client transport. Every request is authenticated before session/body handling. */
export function createHttpServer(cfg: ServerConfig, factory: () => { server: McpServer; close: () => Promise<void> }): http.Server {
  if (!cfg.httpToken) throw new Error('MCPFABRIC_HTTP_TOKEN is required for HTTP transport.');
  const expected = Buffer.from('Bearer ' + cfg.httpToken);
  const hosts = ['127.0.0.1:' + cfg.httpPort, 'localhost:' + cfg.httpPort];
  const origins = hosts.map(host => 'http://' + host);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; close: () => Promise<void>; touched: number }>();
  let pending = 0;
  const server = http.createServer(async (req, res) => {
    let temporary: ReturnType<typeof factory> | undefined;
    try {
      if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin !== undefined && !origins.includes(req.headers.origin))) { res.writeHead(403).end('Invalid Host or Origin'); return; }
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('Unauthorized'); return; }
      if (req.url !== '/mcp') { res.writeHead(404).end('Not found'); return; }
      if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
      const sid = req.headers['mcp-session-id'];
      if (Array.isArray(sid)) { res.writeHead(400).end('Invalid session'); return; }
      let entry = sid ? sessions.get(sid) : undefined;
      if (sid && !entry) { res.writeHead(404).end('Unknown session'); return; }
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = []; let size = 0;
        req.setTimeout(15000, () => req.destroy());
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) { res.writeHead(413).end('Request too large'); return; }
          chunks.push(chunk);
        }
        req.setTimeout(0);
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end('Invalid JSON'); return; }
      }
      if (!entry) {
        if (req.method !== 'POST' || !body || Array.isArray(body) || (body as { method?: unknown }).method !== 'initialize') { res.writeHead(400).end('Initialize a session first'); return; }
        if (sessions.size + pending >= 32) { res.writeHead(503).end('Session limit reached'); return; }
        pending++;
        try {
          temporary = factory();
          const created = temporary;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true, allowedHosts: hosts, allowedOrigins: origins,
            onsessioninitialized: id => { sessions.set(id, entry!); temporary = undefined; },
          });
          entry = { ...created, transport, touched: Date.now() };
          await created.server.connect(transport);
          const sdkOnClose = transport.onclose;
          transport.onclose = () => {
            sdkOnClose?.();
            if (transport.sessionId) sessions.delete(transport.sessionId);
            void created.close().catch(() => {});
          };
        } finally { pending--; }
      }
      entry.touched = Date.now();
      await entry.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed'); else res.end();
    } finally {
      if (temporary) { await temporary.server.close().catch(() => {}); await temporary.close().catch(() => {}); }
    }
  });
  const reap = setInterval(() => {
    for (const [id, entry] of sessions) if (Date.now() - entry.touched > 15 * 60_000) {
      sessions.delete(id); void entry.server.close().catch(() => {}); void entry.close().catch(() => {});
    }
  }, 60_000);
  reap.unref();
  server.on('close', () => { clearInterval(reap); for (const entry of sessions.values()) { void entry.server.close().catch(() => {}); void entry.close().catch(() => {}); } sessions.clear(); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
