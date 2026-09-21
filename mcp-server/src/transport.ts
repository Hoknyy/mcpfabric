/** Authenticated bridge client, including whole-response deadlines and one writer lease. */
export interface BridgeErrorBody { code: string; message: string; data?: unknown }
export class BridgeError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(body: BridgeErrorBody) { super(body.message); this.name = 'BridgeError'; this.code = body.code; this.data = body.data; }
}
export class BridgeUnreachableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) { super(message); this.name = 'BridgeUnreachableError'; this.cause = cause; }
}
const STOPS = new Set(['control.stop', 'control.stopAll', 'nav.stop', 'control.stopUsing']);
interface Status { bridgeProtocol?: number; readOnlyMethods?: string[] }
interface Envelope<T> { ok: boolean; result?: T; error?: BridgeErrorBody }

export class BridgeClient {
  private readMethods?: Set<string>;
  private lease?: string;
  private heartbeat?: ReturnType<typeof setInterval>;
  private writing = false;
  private closing = false;
  constructor(private readonly baseUrl: string, private readonly token: string | undefined, private readonly timeoutMs: number) {}
  fork(): BridgeClient { return new BridgeClient(this.baseUrl, this.token, this.timeoutMs); }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: 'Bearer ' + this.token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new BridgeError({ code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'http_error', message: 'Bridge returned HTTP ' + res.status + '. Check its configuration.' });
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 32 * 1024 * 1024) { await reader.cancel(); throw new BridgeError({ code: 'response_too_large', message: 'Bridge response exceeds 32 MiB.' }); }
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; }
      catch { throw new BridgeError({ code: 'bad_response', message: 'Bridge returned invalid JSON.' }); }
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeUnreachableError(controller.signal.aborted
        ? 'Bridge response timed out after ' + this.timeoutMs + 'ms. An action may already have executed; inspect state before retrying.'
        : 'Bridge connection failed. An action may already have executed; inspect state before retrying.', err);
    } finally { clearTimeout(timer); }
  }
  private async raw<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const env = await this.request<Envelope<T>>('/rpc', { method, params });
    if (env?.ok !== true) throw new BridgeError(env?.error ?? { code: 'bad_response', message: 'Missing RPC result envelope.' });
    return env.result as T;
  }
  async info<T = unknown>(): Promise<T> {
    const info = await this.request<T & { ok?: boolean; error?: BridgeErrorBody }>('/info');
    if (info?.ok === false) throw new BridgeError(info.error ?? { code: 'bad_response', message: 'Status unavailable.' });
    return info;
  }
  private ensureOpen(): void {
    if (this.closing) throw new BridgeError({ code: 'closed', message: 'Controller is closed.' });
  }
  private async acquire(): Promise<void> {
    this.ensureOpen();
    if (this.lease) {
      try { await this.raw('control.heartbeat', { _session: this.lease }); this.ensureOpen(); return; }
      catch (err) { this.ensureOpen(); if (!(err instanceof BridgeError) || err.code !== 'control_lease_required') throw err; this.forgetLease(); }
    }
    const lease = await this.raw<{ sessionId: string; ttlMs: number }>('control.acquire');
    if (this.closing) {
      // close() could not release ownership while its token was still in flight.
      await this.raw('control.release', { _session: lease.sessionId }).catch(() => {});
      this.ensureOpen();
    }
    this.lease = lease.sessionId;
    this.heartbeat = setInterval(() => {
      const current = this.lease;
      if (current && !this.closing) void this.raw('control.heartbeat', { _session: current }).catch(() => { if (this.lease === current) this.forgetLease(); });
    }, Math.max(250, lease.ttlMs / 3));
    this.heartbeat.unref();
  }
  private forgetLease(): void { clearInterval(this.heartbeat); this.heartbeat = undefined; this.lease = undefined; }
  async close(): Promise<void> {
    this.closing = true;
    const lease = this.lease;
    this.forgetLease();
    if (lease) await this.raw('control.release', { _session: lease });
  }
  async withControl<T>(action: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    if (this.writing) throw new BridgeError({ code: 'client_busy', message: 'Another mutation is in progress.' });
    this.writing = true;
    try { await this.acquire(); this.ensureOpen(); return await action(); } finally { this.writing = false; }
  }
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.ensureOpen();
    if (method === 'info.status' || method === 'info.capabilities') return this.raw<T>(method, params);
    if (!this.readMethods) {
      const info = await this.raw<Status>('info.status');
      if (info.bridgeProtocol !== 2 || !Array.isArray(info.readOnlyMethods)) throw new BridgeError({ code: 'upgrade_required', message: 'Install and restart the Lato bridge protocol 2 mod before using this client.' });
      this.readMethods = new Set(info.readOnlyMethods);
    }
    this.ensureOpen();
    if (this.readMethods.has(method)) return this.raw<T>(method, params);
    if (STOPS.has(method)) {
      const result = await this.raw<T>(method, params);
      if (method !== 'control.stopUsing') this.forgetLease();
      return result;
    }
    if (method.startsWith('control.') && ['control.acquire', 'control.release', 'control.heartbeat'].includes(method)) throw new BridgeError({ code: 'reserved', message: 'This client manages its control lease automatically.' });
    if (this.writing) throw new BridgeError({ code: 'client_busy', message: 'Another mutation is in progress. Inspect its result before the next action.' });
    this.writing = true;
    try {
      await this.acquire();
      this.ensureOpen();
      return await this.raw<T>(method, { ...params, _session: this.lease });
    } finally { this.writing = false; }
  }
}
