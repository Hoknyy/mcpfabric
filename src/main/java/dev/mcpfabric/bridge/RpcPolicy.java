package dev.mcpfabric.bridge;

import dev.mcpfabric.config.McpConfig;
import java.util.Set;

/** Shared by direct HTTP and MCP callers; never trust a client's advertised capabilities. */
public final class RpcPolicy {
	private static final Set<String> READS = Set.of(
		"info.status", "info.capabilities", "chat.getRecent", "events.getRecent", "control.status",
		"world.getBlock", "world.getBlocks", "world.findBlocks", "world.getTimeAndWeather", "world.getDimensions", "world.raycast",
		"entities.query", "entities.get", "players.list", "players.get", "players.tabList", "player.getState", "player.getInventory",
		"player.getEquipment", "player.getStatusEffects", "gui.list", "container.read", "vision.screenshot", "vision.describeScene", "nav.status",
		"connection.status");
	private static final Set<String> STOPS = Set.of("control.stop", "control.stopAll", "control.stopUsing", "nav.stop");
	private static final Set<String> SESSIONS = Set.of("control.acquire", "control.heartbeat", "control.release");
	private RpcPolicy() {}
	public static com.google.gson.JsonArray readMethods() { var out = new com.google.gson.JsonArray(); READS.stream().sorted().forEach(out::add); return out; }
	public static boolean isMutation(String method) { return !READS.contains(method) && !STOPS.contains(method) && !SESSIONS.contains(method); }
	public static boolean isClientMutation(String method) {
		return isMutation(method) && (method.startsWith("control.") || method.startsWith("interact.") || method.startsWith("inventory.")
			|| method.startsWith("gui.") || method.startsWith("connection.") || method.startsWith("container.") || method.startsWith("nav.") || method.equals("chat.send"));
	}
	public static void check(McpConfig cfg, ControlLease lease, RpcContext ctx) throws RpcException {
		String m = ctx.method();
		if (STOPS.contains(m) || SESSIONS.contains(m)) return;
		if (m.startsWith("vision.") && !cfg.enableVision) throw RpcException.unavailable("Vision is disabled.");
		if (!isMutation(m)) return;
		if (isClientMutation(m) && !cfg.enablePlayerControl) throw RpcException.unavailable("Player control is disabled.");
		if (m.equals("command.run") && !cfg.enableCommands) throw RpcException.unavailable("Commands are disabled.");
		if ((m.startsWith("world.") || m.startsWith("entities.") || m.startsWith("players.")) && !cfg.enableWorldWrite) {
			throw RpcException.unavailable("Server writes are disabled.");
		}
		lease.require(ctx.optString("_session", null));
	}
}
