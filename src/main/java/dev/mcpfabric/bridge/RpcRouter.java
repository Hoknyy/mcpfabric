package dev.mcpfabric.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;

import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry + dispatcher for RPC methods. Thread-safe: handlers can be registered from both the
 * common and client entrypoints, and dispatched from HTTP worker threads.
 */
public final class RpcRouter {
	private final Map<String, RpcHandler> handlers = new ConcurrentHashMap<>();
	private final dev.mcpfabric.config.McpConfig config;
	private final ControlLease lease = new ControlLease();
	public RpcRouter(dev.mcpfabric.config.McpConfig config) { this.config = config; }
	public ControlLease lease() { return lease; }
	private int ttl() { return Math.max(1000, Math.min(30000, config.controlLeaseMs)); }
	public void registerControl() {
		register("control.acquire", ctx -> {
			JsonObject o = new JsonObject();
			o.addProperty("sessionId", lease.acquire(ttl()));
			o.addProperty("ttlMs", ttl());
			return o;
		});
		register("control.heartbeat", ctx -> { lease.heartbeat(ctx.getString("_session"), ttl()); return Json.ok("renewed"); });
		register("control.release", ctx -> { lease.release(ctx.getString("_session")); return Json.ok("released"); });
		register("control.status", ctx -> { JsonObject o = new JsonObject(); o.addProperty("active", lease.active()); return o; });
	}

	public void register(String method, RpcHandler handler) {
		if (handlers.putIfAbsent(method, handler) != null) {
			McpFabric.LOGGER.warn("[mcpfabric] duplicate RPC method registration: {}", method);
		}
	}

	public boolean has(String method) {
		return handlers.containsKey(method);
	}

	/** Sorted list of all registered method names (for diagnostics / capabilities). */
	public JsonArray methodNames() {
		JsonArray a = new JsonArray();
		new TreeMap<>(handlers).keySet().forEach(a::add);
		return a;
	}

	/** Dispatch a call, returning a full RPC envelope ({ok:true,result} or {ok:false,error}). */
	public JsonObject dispatch(String method, JsonObject params) {
		if (method == null || method.isBlank()) {
			return Json.envelopeError("bad_request", "Missing 'method'.", null);
		}
		RpcHandler handler = handlers.get(method);
		if (handler == null) {
			return Json.envelopeError("unknown_method", "No such method: " + method, null);
		}
		RpcContext ctx = new RpcContext(method, params == null ? new JsonObject() : params.deepCopy());
		ThrowingSupplier<Void> previous = RpcExecution.current();
		try {
			RpcExecution.set(() -> { RpcPolicy.check(config, lease, ctx); return null; });
			RpcExecution.check();
			JsonElement result = handler.handle(ctx);
			return Json.envelopeOk(result);
		} catch (RpcException e) {
			return Json.envelopeError(e.code(), e.getMessage(), e.data());
		} catch (IllegalArgumentException | ArithmeticException e) {
			return Json.envelopeError("bad_request", e.getMessage(), null);
		} catch (Throwable t) {
			McpFabric.LOGGER.error("[mcpfabric] handler '{}' threw", method, t);
			return Json.envelopeError("internal", t.getClass().getSimpleName() + ": " + t.getMessage(), null);
		} finally {
			RpcExecution.set(previous);
		}
	}
}
