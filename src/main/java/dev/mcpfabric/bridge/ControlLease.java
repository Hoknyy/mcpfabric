package dev.mcpfabric.bridge;

import java.util.UUID;
import java.util.function.LongSupplier;

/** One expiring writer per bridge. A lease is coordination, not a replacement for HTTP auth. */
public final class ControlLease {
	private final LongSupplier clock;
	private String token;
	private long deadline;
	private long generation;

	public ControlLease() { this(System::nanoTime); }
	public ControlLease(LongSupplier clock) { this.clock = clock; }

	public synchronized String acquire(int ttlMs) throws RpcException {
		if (active()) throw new RpcException("control_busy", "Another controller owns the bridge; wait for release or expiry.");
		token = UUID.randomUUID().toString();
		deadline = clock.getAsLong() + ttlMs * 1_000_000L;
		generation++;
		return token;
	}

	public synchronized void require(String supplied) throws RpcException {
		if (!active() || supplied == null || !supplied.equals(token)) {
			throw new RpcException("control_lease_required", "Acquire control and supply _session. The previous lease may have expired.");
		}
	}

	public synchronized void heartbeat(String supplied, int ttlMs) throws RpcException {
		require(supplied);
		deadline = clock.getAsLong() + ttlMs * 1_000_000L;
	}

	public synchronized void release(String supplied) throws RpcException {
		require(supplied);
		revoke();
	}

	public synchronized void revoke() { token = null; deadline = 0; generation++; }
	public synchronized boolean active() { return token != null && clock.getAsLong() - deadline < 0; }
	public synchronized long generation() { return generation; }
}
