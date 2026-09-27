package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientMc;
import dev.mcpfabric.client.mixin.PlayerTabOverlayAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.PlayerTabOverlay;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.GameType;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * Read-only {@code players.tabList}: every player entry the server sent to this client, including
 * entries that are present but not listed in the tab, plus the tab header and footer as plain text.
 */
public final class TabListHandlers {
	private TabListHandlers() {}

	public static void register(RpcRouter router) {
		router.register("players.tabList", ctx -> ClientMc.call(TabListHandlers::tabList));
	}

	private static JsonObject tabList() throws RpcException {
		ClientPacketListener connection = ClientMc.player().connection;
		Collection<PlayerInfo> listed = connection.getListedOnlinePlayers();
		List<PlayerInfo> entries = new ArrayList<>(connection.getOnlinePlayers());
		entries.sort(Comparator.comparing((PlayerInfo info) -> !listed.contains(info))
				.thenComparing(info -> profileName(info.getProfile()), String.CASE_INSENSITIVE_ORDER)
				.thenComparing(info -> profileId(info.getProfile())));

		JsonArray players = new JsonArray();
		int listedCount = 0;
		for (PlayerInfo info : entries) {
			boolean isListed = listed.contains(info);
			if (isListed) listedCount++;
			JsonObject p = new JsonObject();
			p.addProperty("uuid", profileId(info.getProfile()).toString());
			p.addProperty("name", profileName(info.getProfile()));
			Component display = info.getTabListDisplayName();
			if (display != null) p.addProperty("displayName", display.getString());
			GameType mode = info.getGameMode();
			if (mode != null) p.addProperty("gameMode", mode.getName());
			p.addProperty("latency", info.getLatency());
			p.addProperty("listed", isListed);
			players.add(p);
		}

		PlayerTabOverlayAccessor overlay = (PlayerTabOverlayAccessor) tabOverlay(ClientMc.mc());
		JsonObject o = new JsonObject();
		addPlain(o, "header", overlay.mcpfabric$getHeader());
		addPlain(o, "footer", overlay.mcpfabric$getFooter());
		o.addProperty("count", players.size());
		o.addProperty("listedCount", listedCount);
		o.add("players", players);
		return o;
	}

	private static void addPlain(JsonObject o, String key, @Nullable Component text) {
		if (text != null) o.addProperty(key, text.getString());
	}

	/** The tab overlay moved from {@code Gui} to {@code Hud} in 26.2. */
	private static PlayerTabOverlay tabOverlay(Minecraft mc) {
		//? if <26.2 {
		return mc.gui.getTabList();
		//?} else
		/*return mc.gui.hud.getTabList();*/
	}

	/** authlib's {@code GameProfile} became a record ({@code id()}, {@code name()}) in 1.21.9. */
	private static String profileName(GameProfile profile) {
		//? if <1.21.9 {
		return profile.getName();
		//?} else
		/*return profile.name();*/
	}

	private static UUID profileId(GameProfile profile) {
		//? if <1.21.9 {
		return profile.getId();
		//?} else
		/*return profile.id();*/
	}
}
