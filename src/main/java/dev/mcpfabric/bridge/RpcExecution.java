package dev.mcpfabric.bridge;

/** Carries the admission check from HTTP to the game thread, where it is checked again. */
public final class RpcExecution {
	private static final ThreadLocal<ThrowingSupplier<Void>> CHECK = new ThreadLocal<>();
	private RpcExecution() {}
	public static ThrowingSupplier<Void> current() { return CHECK.get(); }
	public static void set(ThrowingSupplier<Void> check) { if (check == null) CHECK.remove(); else CHECK.set(check); }
	public static void check() throws RpcException { if (CHECK.get() != null) CHECK.get().get(); }
}
