package dev.mcpfabric.client.mixin;

import net.minecraft.client.gui.components.PlayerTabOverlay;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Read access to the tab header and footer, which vanilla only exposes through setters. */
@Mixin(PlayerTabOverlay.class)
public interface PlayerTabOverlayAccessor {
	@Accessor("header")
	@Nullable Component mcpfabric$getHeader();

	@Accessor("footer")
	@Nullable Component mcpfabric$getFooter();
}
