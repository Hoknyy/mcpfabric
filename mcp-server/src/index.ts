#!/usr/bin/env node
/**
 * mcpfabric MCP server entrypoint.
 *
 * Registers every tool from the catalogue (`tools.ts`) as a thin forwarder to the in-game HTTP
 * bridge, then serves them over stdio (default) or streamable HTTP. All diagnostic logging goes to
 * stderr so it never corrupts the stdio JSON-RPC stream.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHttpServer } from "./http.js";
import { readFileSync } from "node:fs";

import { loadConfig, type ServerConfig } from "./config.js";
import { BridgeClient, BridgeError, BridgeUnreachableError } from "./bridge.js";
import { TOOLS, type ToolDef } from "./tools.js";

const PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

function log(...args: unknown[]): void {
  // stderr only — stdout is reserved for the stdio transport.
  console.error("[mcpfabric]", ...args);
}

function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof BridgeUnreachableError) {
    text = `Bridge unreachable: ${err.message}`;
  } else if (err instanceof BridgeError) {
    text = `Bridge error [${err.code}]: ${err.message}`;
    if (err.data !== undefined) text += `\n${JSON.stringify(err.data)}`;
  } else if (err instanceof Error) {
    text = `Error: ${err.message}`;
  } else {
    text = `Error: ${String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text }] };
}

function jsonResult(result: unknown): CallToolResult {
  if (result === undefined || result === null) {
    return { content: [{ type: "text", text: "ok" }] };
  }
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const out: CallToolResult = { content: [{ type: "text", text }] };
  if (typeof result === "object") {
    out.structuredContent = result as Record<string, unknown>;
  }
  return out;
}

interface ScreenshotResult {
  format?: string;
  base64: string;
  width?: number;
  height?: number;
}

function imageResult(result: unknown): CallToolResult {
  const r = result as ScreenshotResult;
  if (!r || typeof r.base64 !== "string") {
    return errorResult(new Error("Bridge did not return image data."));
  }
  const mimeType = r.format === "jpeg" || r.format === "jpg" ? "image/jpeg" : "image/png";
  const meta = `Screenshot ${r.width ?? "?"}x${r.height ?? "?"} (${mimeType})`;
  return {
    content: [
      { type: "image", data: r.base64, mimeType },
      { type: "text", text: meta },
    ],
  };
}

function registerTools(server: McpServer, bridge: BridgeClient): void {
  for (const def of TOOLS as ToolDef[]) {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
    };

    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await bridge.call(def.method, args ?? {});
        return def.kind === "image" ? imageResult(result) : jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    };

    server.registerTool(def.name, config, handler);
  }
}

function buildServer(bridge: BridgeClient): McpServer {
  const server = new McpServer(
    { name: "mcpfabric", version: PKG_VERSION },
    {
      instructions:
        "Control and observe Minecraft through the Lato MCPFabric bridge protocol 2. " +
        "Writes acquire an exclusive expiring control lease automatically. Read GUI/container first and pass its expectedScreen/menuId/stateId to actions. " +
        "A timeout after an action starts is uncertain: inspect state before retrying. stop_all_controls releases every held input. " +
        "Call get_status first to learn which side you are on and which capability groups are available. " +
        "Client-side tools (get_self, control_*, interact_*, vision, navigation) drive the local player; " +
        "server-side tools (players_*, run_command, world write) require an integrated or dedicated server.",
    },
  );
  registerTools(server, bridge);
  return server;
}

async function runStdio(bridge: BridgeClient): Promise<void> {
  const server = buildServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The SDK stdio transport does not close itself when stdin reaches EOF.
    // Mark the bridge closed immediately, including any in-flight acquisition.
    const released = bridge.close().catch(() => {});
    void server.close().catch(() => {}).then(() => released);
  };
  server.server.onclose = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  log(`stdio transport ready (bridge: ${process.env.MCPFABRIC_URL ?? "http://127.0.0.1:25599"})`);
}

async function runHttp(bridge: BridgeClient, cfg: ServerConfig): Promise<void> {
  const httpServer = createHttpServer(cfg, () => {
    const sessionBridge = bridge.fork();
    return { server: buildServer(sessionBridge), close: () => sessionBridge.close() };
  });
  httpServer.listen(cfg.httpPort, "127.0.0.1", () => log("authenticated streamable-HTTP transport ready"));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const bridge = new BridgeClient(cfg.bridgeUrl, cfg.token, cfg.timeoutMs);

  // Best-effort connectivity hint (does not block startup; the mod may launch later).
  bridge
    .info()
    .then((info) => log("connected to bridge:", JSON.stringify(info)))
    .catch((err) => log("bridge not reachable yet:", (err as Error).message));

  if (cfg.transport === "http") {
    await runHttp(bridge, cfg);
  } else {
    await runStdio(bridge);
  }
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
