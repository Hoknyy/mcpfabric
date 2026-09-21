package dev.mcpfabric.bridge;

import com.google.gson.JsonObject;
import dev.mcpfabric.config.McpConfig;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Dependency-free regression suite; run by the Gradle safetyTest/check tasks. */
public final class BridgeSafetyTest {
	private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
	private static void rejected(ThrowingSupplier<?> action, String code) throws Exception {
		try { action.get(); throw new AssertionError("Expected " + code); }
		catch (RpcException e) { check(e.code().equals(code), "Unexpected error: " + e.code()); }
	}
	public static void main(String[] args) throws Exception {
		AtomicLong clock = new AtomicLong();
		ControlLease lease = new ControlLease(clock::get);
		String first = lease.acquire(1000);
		rejected(() -> lease.acquire(1000), "control_busy");
		rejected(() -> { lease.heartbeat("wrong", 1000); return null; }, "control_lease_required");
		clock.set(1_000_000_001L);
		rejected(() -> { lease.require(first); return null; }, "control_lease_required");
		String second = lease.acquire(1000);
		check(!first.equals(second), "Expired lease reused");
		lease.release(second);
		check(!lease.active(), "Released lease active");

		Runnable[] queued = new Runnable[1]; AtomicInteger effects = new AtomicInteger();
		rejected(() -> MainThread.call(task -> queued[0] = task, 5, effects::incrementAndGet), "timeout");
		queued[0].run(); check(effects.get() == 0, "Expired queued mutation executed");
		check(MainThread.call(Runnable::run, 1000, () -> 42) == 42, "Legitimate synchronous action failed");

		ExecutorService workers = Executors.newFixedThreadPool(2);
		try {
			CountDownLatch started = new CountDownLatch(1), finish = new CountDownLatch(1);
			Future<String> uncertain = workers.submit(() -> {
				try { MainThread.call(workers, 150, () -> { started.countDown(); try { finish.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } return effects.incrementAndGet(); }); return "unexpected"; }
				catch (RpcException e) { return e.code(); }
			});
			check(started.await(1, TimeUnit.SECONDS), "Task never started");
			check(uncertain.get(2, TimeUnit.SECONDS).equals("action_uncertain"), "Running action incorrectly reported cancelled");
			finish.countDown();
		} finally { workers.shutdown(); check(workers.awaitTermination(2, TimeUnit.SECONDS), "Worker leaked"); }

		McpConfig cfg = new McpConfig(); ControlLease live = new ControlLease();
		JsonObject params = new JsonObject(); params.addProperty("_session", live.acquire(10000));
		cfg.enablePlayerControl = false;
		for (String method : new String[]{"control.setInput", "control.look", "control.startUsing", "inventory.dropSlot", "interact.dropItem", "gui.click", "gui.type", "gui.key", "container.click", "nav.pathTo"}) {
			rejected(() -> { RpcPolicy.check(cfg, live, new RpcContext(method, params)); return null; }, "unavailable");
		}
		for (String method : new String[]{"player.getState", "gui.list", "container.read", "control.stop", "control.stopAll", "nav.stop"}) RpcPolicy.check(cfg, live, new RpcContext(method, new JsonObject()));
		cfg.enableVision = false;
		for (String method : new String[]{"vision.screenshot", "vision.describeScene"}) rejected(() -> { RpcPolicy.check(cfg, live, new RpcContext(method, params)); return null; }, "unavailable");
		cfg.enablePlayerControl = true;
		RpcPolicy.check(cfg, live, new RpcContext("gui.click", params)); // No player-present prerequisite: pre-join GUI works.

		AtomicReference<Runnable> pending = new AtomicReference<>(); CountDownLatch admitted = new CountDownLatch(1);
		ExecutorService caller = Executors.newSingleThreadExecutor();
		try {
			Future<String> outcome = caller.submit(() -> {
				RpcExecution.set(() -> { RpcPolicy.check(cfg, live, new RpcContext("gui.click", params)); return null; });
				try { MainThread.call(task -> { pending.set(task); admitted.countDown(); }, 1000, effects::incrementAndGet); return "executed"; }
				catch (RpcException e) { return e.code(); }
				finally { RpcExecution.set(null); }
			});
			check(admitted.await(1, TimeUnit.SECONDS), "No queued task");
			int before = effects.get(); live.revoke(); pending.get().run();
			check(outcome.get().equals("control_lease_required"), "Revoked queued mutation admitted");
			check(effects.get() == before, "Revoked mutation ran");
		} finally { caller.shutdownNow(); }
		System.out.println("PASS BridgeSafetyTest: expiry, exclusivity, queued cancellation, uncertain running action, capabilities, pre-join GUI and execution-time lease check");
	}
}
