package dev.mcpfabric.bridge;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Bridges HTTP worker threads onto the Minecraft main thread.
 *
 * <p>All access to world/entity/player state must happen on the game thread. Both
 * {@code MinecraftServer} and {@code Minecraft} are {@link Executor}s, so handlers schedule work
 * via these helpers and block the (cheap) HTTP worker thread until the result is ready.
 */
public final class MainThread {
	private MainThread() {}

	public static <T> T call(Executor gameThread, long timeoutMs, ThrowingSupplier<T> task) throws RpcException {
		CompletableFuture<T> future = new CompletableFuture<>();
		AtomicInteger state = new AtomicInteger(0); // queued, running, cancelled
		long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
		ThrowingSupplier<Void> check = RpcExecution.current();
		gameThread.execute(() -> {
			if (System.nanoTime() - deadline >= 0 || !state.compareAndSet(0, 1)) {
				state.compareAndSet(0, 2);
				future.completeExceptionally(new RpcException("timeout", "Queued action expired without executing."));
				return;
			}
			ThrowingSupplier<Void> previous = RpcExecution.current();
			try {
				RpcExecution.set(check);
				RpcExecution.check();
				future.complete(task.get());
			} catch (Throwable t) {
				future.completeExceptionally(t);
			} finally {
				RpcExecution.set(previous);
			}
		});
		try {
			return future.get(timeoutMs, TimeUnit.MILLISECONDS);
		} catch (TimeoutException e) {
			boolean cancelled = state.compareAndSet(0, 2);
			throw new RpcException(cancelled ? "timeout" : "action_uncertain", cancelled ? "Queued action cancelled before execution." : "Action already started; outcome uncertain. Inspect state; do not repeat the action.");
		} catch (InterruptedException e) {
			boolean cancelled = state.compareAndSet(0, 2);
			Thread.currentThread().interrupt();
			throw new RpcException(cancelled ? "interrupted" : "action_uncertain", cancelled ? "Queued action cancelled." : "Interrupted after action started; inspect state before continuing.");
		} catch (ExecutionException e) {
			Throwable cause = e.getCause() == null ? e : e.getCause();
			if (cause instanceof RpcException rpc) {
				throw rpc;
			}
			throw new RpcException("internal", cause.getClass().getSimpleName() + ": " + cause.getMessage());
		}
	}

	/** Schedule work without waiting for a result. */
	public static void run(Executor gameThread, Runnable task) {
		gameThread.execute(task);
	}
}
