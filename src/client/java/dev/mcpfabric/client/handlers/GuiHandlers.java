package dev.mcpfabric.client.handlers;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.mcpfabric.bridge.Json;
import dev.mcpfabric.bridge.RpcContext;
import dev.mcpfabric.bridge.RpcException;
import dev.mcpfabric.bridge.RpcRouter;
import dev.mcpfabric.client.ClientMc;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ItemLore;
import org.lwjgl.glfw.GLFW;
//? if >=1.21.9 {
/*import net.minecraft.client.input.CharacterEvent;*/
/*import net.minecraft.client.input.KeyEvent;*/
/*import net.minecraft.client.input.MouseButtonEvent;*/
/*import net.minecraft.client.input.MouseButtonInfo;*/
//?}
//? if <26.1 {
import net.minecraft.world.inventory.ClickType;
//?}

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * GUI interaction for the local client: inspect the open screen, click widgets, type text, send
 * keys, close screens, and read/operate container menus. Makes shop/quest/crate flows testable
 * without OS-level input injection.
 */
public final class GuiHandlers {
	private GuiHandlers() {}

	private static final Map<String, Integer> KEYS = new HashMap<>();

	static {
		KEYS.put("escape", GLFW.GLFW_KEY_ESCAPE);
		KEYS.put("esc", GLFW.GLFW_KEY_ESCAPE);
		KEYS.put("enter", GLFW.GLFW_KEY_ENTER);
		KEYS.put("return", GLFW.GLFW_KEY_ENTER);
		KEYS.put("tab", GLFW.GLFW_KEY_TAB);
		KEYS.put("space", GLFW.GLFW_KEY_SPACE);
		KEYS.put("backspace", GLFW.GLFW_KEY_BACKSPACE);
		KEYS.put("delete", GLFW.GLFW_KEY_DELETE);
		KEYS.put("up", GLFW.GLFW_KEY_UP);
		KEYS.put("down", GLFW.GLFW_KEY_DOWN);
		KEYS.put("left", GLFW.GLFW_KEY_LEFT);
		KEYS.put("right", GLFW.GLFW_KEY_RIGHT);
		KEYS.put("home", GLFW.GLFW_KEY_HOME);
		KEYS.put("end", GLFW.GLFW_KEY_END);
		KEYS.put("pageup", GLFW.GLFW_KEY_PAGE_UP);
		KEYS.put("pagedown", GLFW.GLFW_KEY_PAGE_DOWN);
	}

	public static void register(RpcRouter router) {
		router.register("gui.list", ctx -> ClientMc.call(GuiHandlers::listScreen));

		router.register("gui.click", ctx -> ClientMc.call(() -> clickWidget(ctx)));

		router.register("gui.type", ctx -> ClientMc.call(() -> typeText(ctx)));

		router.register("gui.key", ctx -> ClientMc.call(() -> pressKey(ctx)));

		router.register("gui.close", ctx -> ClientMc.call(() -> {
			Screen screen = checkedScreen(ctx);
			String name = screen.getClass().getSimpleName();
			screen.onClose();
			return Json.ok("closed " + name);
		}));

		router.register("container.read", ctx -> ClientMc.call(GuiHandlers::readContainer));

		router.register("container.click", ctx -> ClientMc.call(() -> clickContainerSlot(ctx)));
	}

	// ----- screen / widgets --------------------------------------------------------------------

	private static Screen screen() throws RpcException {
		//? if <26.2 {
		Screen s = ClientMc.mc().screen;
		//?} else
		/*Screen s = ClientMc.mc().gui.screen();*/
		if (s == null) throw RpcException.badRequest("No screen is open.");
		return s;
	}

	private static Screen checkedScreen(RpcContext ctx) throws RpcException {
		Screen s = screen();
		if (ctx.method().startsWith("gui.") && !s.getClass().getName().equals(ctx.getString("expectedScreen"))) {
			throw new RpcException("stale_screen", "The screen changed; inspect it again before acting.");
		}
		if (s instanceof AbstractContainerScreen<?> cs) {
			if (ctx.getInt("expectedMenuId") != cs.getMenu().containerId) throw new RpcException("stale_menu", "The container changed; read it again.");
			if (ctx.has("expectedStateId") && ctx.getInt("expectedStateId") != cs.getMenu().getStateId()) throw new RpcException("stale_menu", "Container contents changed; read it again.");
		}
		if (ctx.has("expectedTitle") && !s.getTitle().getString().equals(ctx.getString("expectedTitle"))) throw new RpcException("stale_screen", "Screen title changed.");
		return s;
	}

	private static JsonObject listScreen() throws RpcException {
		Screen s = screen();
		JsonObject o = new JsonObject();
		o.addProperty("screen", s.getClass().getName());
		o.addProperty("title", s.getTitle().getString());
		if (s instanceof AbstractContainerScreen<?> cs) {
			o.addProperty("menuId", cs.getMenu().containerId);
			o.addProperty("stateId", cs.getMenu().getStateId());
			o.addProperty("slotCount", cs.getMenu().slots.size());
		}

		JsonArray widgets = new JsonArray();
		List<? extends GuiEventListener> children = s.children();
		for (int i = 0; i < children.size(); i++) {
			if (!(children.get(i) instanceof AbstractWidget w)) continue;
			JsonObject j = new JsonObject();
			j.addProperty("index", i);
			j.addProperty("type", w.getClass().getSimpleName());
			j.addProperty("text", w.getMessage().getString());
			j.addProperty("x", w.getX());
			j.addProperty("y", w.getY());
			j.addProperty("width", w.getWidth());
			j.addProperty("height", w.getHeight());
			j.addProperty("active", w.isActive());
			if (w instanceof EditBox box) {
				j.addProperty("value", box.getValue());
				j.addProperty("focused", box.isFocused());
			}
			widgets.add(j);
		}
		o.add("widgets", widgets);
		return o;
	}

	private static JsonObject clickWidget(RpcContext ctx) throws RpcException {
		Screen s = checkedScreen(ctx);
		double mx;
		double my;
		if (ctx.has("x") && ctx.has("y")) {
			mx = ctx.getDouble("x");
			my = ctx.getDouble("y");
		} else {
			AbstractWidget target = findWidget(s, ctx.optInt("index", -1), ctx.optString("text", null));
			if (!target.isActive() || !target.visible) throw RpcException.badRequest("Widget is disabled or hidden.");
			mx = target.getX() + target.getWidth() / 2.0;
			my = target.getY() + target.getHeight() / 2.0;
		}
		String button = ctx.optString("button", "left");
		int btn = button.equalsIgnoreCase("right") ? 1 : button.equalsIgnoreCase("middle") ? 2 : 0;
		if (!dispatchClick(s, mx, my, btn)) throw RpcException.badRequest("Screen did not handle this click.");

		JsonObject o = new JsonObject();
		o.addProperty("clicked", true);
		o.addProperty("button", button);
		o.addProperty("x", mx);
		o.addProperty("y", my);
		return o;
	}

	private static AbstractWidget findWidget(Screen s, int index, String text) throws RpcException {
		List<? extends GuiEventListener> children = s.children();
		if (index >= 0) {
			if (index >= children.size()) {
				throw RpcException.badRequest("Widget index out of range (0-" + (children.size() - 1) + "): " + index);
			}
			if (!(children.get(index) instanceof AbstractWidget w)) {
				throw RpcException.badRequest("Widget " + index + " is not clickable.");
			}
			return w;
		}
		if (text != null && !text.isBlank()) {
			String needle = text.toLowerCase();
			for (GuiEventListener child : children) {
				if (child instanceof AbstractWidget w && w.getMessage().getString().toLowerCase().contains(needle)) {
					return w;
				}
			}
			throw RpcException.badRequest("No widget matching text: " + text);
		}
		throw RpcException.badRequest("Provide 'index', 'text' or 'x'+'y'.");
	}

	private static JsonObject typeText(RpcContext ctx) throws RpcException {
		Screen s = checkedScreen(ctx);
		String text = ctx.getString("text");
		if (ctx.optBool("clear", false)) {
			for (GuiEventListener child : s.children()) {
				if (child instanceof EditBox box && box.isFocused()) box.setValue("");
			}
		}
		for (char c : text.toCharArray()) {
			//? if <1.21.9 {
			s.charTyped(c, 0);
			//?} else
			/*s.charTyped(new CharacterEvent(c));*/
		}
		if (ctx.optBool("enter", false)) {
			//? if <1.21.9 {
			s.keyPressed(GLFW.GLFW_KEY_ENTER, 0, 0);
			s.keyReleased(GLFW.GLFW_KEY_ENTER, 0, 0);
			//?} else
			/*s.keyPressed(new KeyEvent(GLFW.GLFW_KEY_ENTER, 0, 0)); s.keyReleased(new KeyEvent(GLFW.GLFW_KEY_ENTER, 0, 0));*/
		}
		JsonObject o = new JsonObject();
		o.addProperty("typed", text);
		return o;
	}

	private static JsonObject pressKey(RpcContext ctx) throws RpcException {
		Screen s = checkedScreen(ctx);
		int code;
		if (ctx.has("keyCode")) {
			code = ctx.getInt("keyCode");
		} else {
			String raw = ctx.getString("key");
			String name = raw.toLowerCase().replace("_", "").replace(" ", "");
			Integer mapped = KEYS.get(name);
			if (mapped == null) throw RpcException.badRequest("Unknown key: " + raw);
			code = mapped;
		}
		//? if <1.21.9 {
		s.keyPressed(code, 0, 0);
		s.keyReleased(code, 0, 0);
		//?} else
		/*s.keyPressed(new KeyEvent(code, 0, 0)); s.keyReleased(new KeyEvent(code, 0, 0));*/
		JsonObject o = new JsonObject();
		o.addProperty("keyCode", code);
		return o;
	}

	/**
	 * Click/release on a screen. The GUI event API switched to record event objects
	 * ({@code MouseButtonEvent}, {@code CharacterEvent}, {@code KeyEvent}) in 1.21.9.
	 */
	private static boolean dispatchClick(Screen s, double mx, double my, int btn) {
		//? if <1.21.9 {
		boolean handled = s.mouseClicked(mx, my, btn);
		s.mouseReleased(mx, my, btn);
		return handled;
		//?} else
		/*boolean handled = s.mouseClicked(new MouseButtonEvent(mx, my, new MouseButtonInfo(btn, 0)), false); s.mouseReleased(new MouseButtonEvent(mx, my, new MouseButtonInfo(btn, 0))); return handled;*/
	}

	// ----- containers --------------------------------------------------------------------------

	private static JsonObject readContainer() throws RpcException {
		Screen s = screen();
		if (!(s instanceof AbstractContainerScreen<?> cs)) {
			throw RpcException.badRequest("No container screen is open.");
		}
		AbstractContainerMenu menu = cs.getMenu();
		int playerStart = menu.slots.stream().filter(slot -> slot.container == ClientMc.mc().player.getInventory()).mapToInt(slot -> slot.index).min().orElse(-1);

		JsonObject o = new JsonObject();
		o.addProperty("menuId", menu.containerId);
		o.addProperty("stateId", menu.getStateId());
		JsonObject carried = new JsonObject();
		carried.addProperty("id", BuiltInRegistries.ITEM.getKey(menu.getCarried().getItem()).toString());
		carried.addProperty("count", menu.getCarried().getCount());
		o.add("carried", carried);
		o.addProperty("title", s.getTitle().getString());
		o.addProperty("slotCount", menu.slots.size());
		o.addProperty("playerInventoryStart", playerStart);

		JsonArray items = new JsonArray();
		for (Slot slot : menu.slots) {
			ItemStack stack = slot.getItem();
			if (stack.isEmpty()) continue;
			JsonObject j = new JsonObject();
			j.addProperty("slot", slot.index);
			j.addProperty("playerSlot", slot.container == ClientMc.mc().player.getInventory());
			j.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
			j.addProperty("count", stack.getCount());
			j.addProperty("name", stack.getHoverName().getString());
			ItemLore lore = stack.get(DataComponents.LORE);
			if (lore != null && !lore.lines().isEmpty()) {
				JsonArray lines = new JsonArray();
				for (Component line : lore.lines()) lines.add(line.getString());
				j.add("lore", lines);
			}
			items.add(j);
		}
		o.add("items", items);
		return o;
	}

	private static JsonObject clickContainerSlot(RpcContext ctx) throws RpcException {
		LocalPlayer p = ClientMc.player();
		MultiPlayerGameMode gm = ClientMc.gameMode();
		Screen s = checkedScreen(ctx);
		if (!(s instanceof AbstractContainerScreen<?> cs)) {
			throw RpcException.badRequest("No container screen is open.");
		}
		int slot = ctx.getInt("slot");
		String buttonName = ctx.optString("button", "left");
		if (!buttonName.equals("left") && !buttonName.equals("right")) throw RpcException.badRequest("button must be left or right.");
		int button = buttonName.equals("right") ? 1 : 0;
		String mode = ctx.optString("mode", "pickup");
		if (!java.util.Set.of("pickup", "quick_move", "throw", "swap").contains(mode)) throw RpcException.badRequest("Unknown container mode.");
		if (slot < 0 || slot >= cs.getMenu().slots.size()) throw RpcException.badRequest("Slot outside the current menu.");
		if (mode.equals("swap")) {
			button = ctx.getInt("hotbarSlot");
			if ((button < 0 || button > 8) && button != 40) throw RpcException.badRequest("hotbarSlot must be 0-8 or 40 (offhand).");
		}
		ItemStack current = cs.getMenu().getSlot(slot).getItem();
		if (ctx.has("expectedItemId") && !BuiltInRegistries.ITEM.getKey(current.getItem()).toString().equals(ctx.getString("expectedItemId"))) throw new RpcException("stale_item", "Slot item changed.");
		if (ctx.has("expectedItemName") && !current.getHoverName().getString().equals(ctx.getString("expectedItemName"))) throw new RpcException("stale_item", "Slot item name changed.");
		containerInput(gm, cs.getMenu().containerId, slot, button, mode, p);

		JsonObject o = new JsonObject();
		o.addProperty("slot", slot);
		o.addProperty("mode", mode);
		o.addProperty("button", button);
		return o;
	}

	/**
	 * Click a container slot. {@code handleInventoryMouseClick(..., ClickType, ...)} became
	 * {@code handleContainerInput(..., ContainerInput, ...)} in 26.1 (same constant names).
	 */
	private static void containerInput(MultiPlayerGameMode gm, int containerId, int slot, int button, String mode, LocalPlayer p) {
		//? if <26.1 {
		gm.handleInventoryMouseClick(containerId, slot, button, mode.equals("quick_move") ? ClickType.QUICK_MOVE : mode.equals("throw") ? ClickType.THROW : mode.equals("swap") ? ClickType.SWAP : ClickType.PICKUP, p);
		//?} else
		/*gm.handleContainerInput(containerId, slot, button, mode.equals("quick_move") ? net.minecraft.world.inventory.ContainerInput.QUICK_MOVE : mode.equals("throw") ? net.minecraft.world.inventory.ContainerInput.THROW : mode.equals("swap") ? net.minecraft.world.inventory.ContainerInput.SWAP : net.minecraft.world.inventory.ContainerInput.PICKUP, p);*/
	}
}
