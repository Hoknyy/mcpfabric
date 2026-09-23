package dev.mcpfabric.client.handlers;

import com.google.gson.JsonObject;
import dev.mcpfabric.McpFabric;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientMc;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;

import java.util.Locale;

/**
 * Session lifecycle of the local client, so disconnect/reconnect journeys run without a human:
 * {@code connection.disconnect} leaves the current multiplayer server like the pause-menu button,
 * {@code connection.join} connects to an address listed in {@code allowedJoinAddresses} (empty by
 * default: joining is refused), and {@code connection.status} reports where the client is.
 */
public final class ConnectionHandlers {
	private ConnectionHandlers() {}

	public static void register(RpcRouter router) {
		router.register("connection.status", ctx -> ClientMc.call(ConnectionHandlers::status));
		router.register("connection.disconnect", ctx -> ClientMc.call(ConnectionHandlers::disconnect));
		router.register("connection.join", ctx -> ClientMc.call(() -> join(ctx.getString("address"))));
	}

	private static JsonObject status() {
		Minecraft mc = ClientMc.mc();
		ServerData server = mc.getCurrentServer();
		//? if <26.2 {
		Object screen = mc.screen;
		//?} else
		/*Object screen = mc.gui.screen();*/
		JsonObject o = new JsonObject();
		o.addProperty("inWorld", mc.level != null && mc.player != null);
		o.addProperty("serverAddress", server == null ? null : server.ip);
		o.addProperty("screen", screen == null ? null : screen.getClass().getName());
		return o;
	}

	private static JsonObject disconnect() throws RpcException {
		Minecraft mc = ClientMc.mc();
		if (mc.level == null || mc.player == null) throw RpcException.badRequest("Not connected to a world.");
		if (mc.hasSingleplayerServer()) throw RpcException.badRequest("Refusing to leave a singleplayer world.");
		String from = mc.getCurrentServer() == null ? "" : mc.getCurrentServer().ip;
		//? if >=26.2 {
		/*mc.disconnectFromWorld(ClientLevel.DEFAULT_QUIT_MESSAGE);
		JsonObject o = new JsonObject();
		o.addProperty("disconnected", true);
		o.addProperty("from", from);
		return o;
		*///?} else {
		throw RpcException.unavailable("connection.disconnect requires Minecraft 26.2 or later (from " + from + ").");
		//?}
	}

	private static JsonObject join(String address) throws RpcException {
		Minecraft mc = ClientMc.mc();
		String exact = address == null ? "" : address.trim();
		boolean allowed = McpFabric.config().allowedJoinAddresses.stream()
				.anyMatch(candidate -> candidate != null && candidate.trim().toLowerCase(Locale.ROOT).equals(exact.toLowerCase(Locale.ROOT)));
		if (!allowed) throw RpcException.badRequest("Address is not in allowedJoinAddresses: " + exact);
		if (!ServerAddress.isValidAddress(exact)) throw RpcException.badRequest("Invalid server address: " + exact);
		if (mc.level != null || mc.player != null) throw RpcException.badRequest("Already in a world; disconnect first.");
		//? if >=26.2 {
		/*ServerData server = new ServerData(exact, exact, ServerData.Type.OTHER);
		server.setResourcePackStatus(ServerData.ServerPackStatus.ENABLED);
		ConnectScreen.startConnecting(new TitleScreen(), mc, ServerAddress.parseString(exact), server, false, null);
		JsonObject o = new JsonObject();
		o.addProperty("connecting", true);
		o.addProperty("address", exact);
		return o;
		*///?} else {
		throw RpcException.unavailable("connection.join requires Minecraft 26.2 or later.");
		//?}
	}
}
