# mcpfabric MCP server

Bridges an MCP client (Claude Desktop / Claude Code / any MCP host) to the in-game HTTP bridge
exposed by the **mcpfabric** Fabric mod, publishing ~50 tools to observe and control Minecraft.

## Install & build

```bash
npm install
npm run build       # -> dist/index.js
npm run typecheck   # tsc --noEmit
```

## Run

The MCP client normally launches this process. Manually:

```bash
MCPFABRIC_URL=http://127.0.0.1:25599 MCPFABRIC_TOKEN=<token> node dist/index.js
```

## Environment

| Variable               | Default                  | Meaning                                        |
|------------------------|--------------------------|------------------------------------------------|
| `MCPFABRIC_URL`        | `http://127.0.0.1:25599` | In-game bridge base URL.                        |
| `MCPFABRIC_TOKEN`      | —                        | Bearer token from `config/mcpfabric.config.json`. |
| `MCPFABRIC_TIMEOUT_MS` | `15000`                  | Per-call timeout.                               |
| `MCPFABRIC_TRANSPORT`  | `stdio`                  | `stdio` (default) or `http`.                    |
| `MCPFABRIC_HTTP_TOKEN` | required in HTTP mode | Separate bearer token authenticating the MCP caller on every request. |
| `MCPFABRIC_HTTP_PORT`  | `25600`                  | Port for the streamable-HTTP transport (`/mcp`).|

## Architecture

`src/tools.ts` is the single source of truth for the tool catalogue: each entry maps an MCP tool
to a bridge RPC `method` plus a zod input schema. `src/index.ts` registers every entry generically
(forwarding args to `POST /rpc`) and renders results as JSON, except `screenshot` which returns an
image content block. `src/bridge.ts` re-exports the authenticated client from `src/transport.ts`; `src/http.ts` owns the optional authenticated MCP HTTP transport; `src/config.ts` reads env config.

Keep tool names/methods in sync with the Java handler registry in the mod
(`dev.mcpfabric.handlers.*` and `dev.mcpfabric.client.handlers.*`).

## Lato protocol 2

Use this adapter with mod `0.2.2-lato.1` or later and restart Minecraft after
updating the JAR. The adapter acquires a short, exclusive writer lease before
mutations, renews it while connected and releases it on close. Read calls stay
available to other agents. `stop_all_controls` is an emergency stop that also
revokes the current writer. Timeouts can leave an already started action with an
uncertain outcome: read the state before deciding another action; never blindly
retry a purchase, click or command.

GUI mutations require the screen identity returned by `list_gui`; container
clicks require the menu ID returned by `read_container`. State IDs, titles and
expected items provide additional stale-view checks. Refresh the view after each
mutation. See the tool schemas and [harness guide](../harness/README.md).

HTTP mode binds to loopback and requires `Authorization: Bearer
<MCPFABRIC_HTTP_TOKEN>` for initialize, tools and session deletion. Its Host must
be `127.0.0.1:<port>` or `localhost:<port>`. Native callers can omit Origin;
when present, it must exactly match one of the corresponding HTTP origins.
Untrusted origins and unknown session IDs are rejected. Do not reuse the
in-game `MCPFABRIC_TOKEN` as the caller token. Default stdio needs no caller token.

Run `npm test` for type checking/build and the transport regression suite.
