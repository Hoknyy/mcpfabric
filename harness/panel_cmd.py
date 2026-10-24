"""Console consumer of AA-Main's verified transport. JSON stdin, never a shell command.

Before any command, no real or unresolved player may be online on the private clone network:
AA-Main's clones-restart.py reads the clone proxy (glist all) and classifies every player as
disposable (disposablePlayerUuids) or blocking. One blocking player refuses the command
(accepted: false), the same rule as AA-Main infra/clones-console.py for writes.

Exceptions and load:
- the exact commands that only REMOVE a right (RIGHT_REMOVALS) are never refused by the guard, so a
  teardown deop always goes through even if a real player joined or the proxy read failed;
- one read serves the console steps of the next GUARD_TTL_SECONDS (one panel read per step, not per
  command; the panel answers 429 otherwise). The cache keeps the outcome of the read: a fresh
  failed or blocking read refuses at once, a stale one is read again.
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

RIGHT_REMOVALS = frozenset({"deop Hokny", "deop Tikifirst"})
GUARD_TTL_SECONDS = 5.0
GUARD_CACHE = Path(tempfile.gettempdir()) / "mcpfabric-panel-guard.json"


def load_restart(infra: Path):
    spec = importlib.util.spec_from_file_location("clones_restart_for_harness", infra / "clones-restart.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def blocking_players(restart) -> list:
    """Real or unresolved players on the clone proxy; a proxy that is not running counts as unknown."""
    deploy_config, registry, fabric = restart.load_sources()
    context = restart.load_clone_context(deploy_config, registry, fabric)
    client = restart.PanelClient(deploy_config)
    restart.verify_live_proxy(client, context)
    state = restart.server_state(client, context.proxy_identifier)
    if state != "running":
        return ["<proxy " + str(state) + ">"]
    snapshot = restart.read_proxy_players(client, context)
    _disposable, blocking = restart.classify_players(client, context, snapshot)
    return list(blocking)


def guarded_blocking(infra: Path, restart_loader, cache: Path = GUARD_CACHE, now=time.time) -> list:
    """Blocking players, read at most once per GUARD_TTL_SECONDS; a fresh cached refusal is kept."""
    try:
        cached = json.loads(cache.read_text(encoding="utf-8"))
        age = now() - float(cached["checked_at"])
        if 0 <= age < GUARD_TTL_SECONDS and isinstance(cached.get("blocking"), list):
            return cached["blocking"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    restart = restart_loader(infra)
    try:
        blocking = blocking_players(restart)
    except (restart.Refusal, restart.TechnicalError, OSError, ValueError, KeyError):
        blocking = ["<players unknown>"]
    try:
        temporary = cache.with_name(cache.name + "." + str(os.getpid()))
        temporary.write_text(json.dumps({"checked_at": now(), "blocking": blocking}), encoding="utf-8")
        os.replace(temporary, cache)
    except OSError:
        pass
    return blocking


def main(restart_loader=load_restart, opener=None, cache: Path = GUARD_CACHE):
    if len(sys.argv) != 3 or sys.argv[1] != "--sources":
        raise SystemExit("usage: panel_cmd.py --sources <AA-Lato/config/sources.json>")
    sources = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    infra = Path(sources["aa_main_root"]) / "infra"
    sys.path.insert(0, str(infra))
    import panel_transport
    payload = json.loads(sys.stdin.read(16385))
    if not isinstance(payload, dict) or set(payload) != {"server", "command"}:
        raise SystemExit("invalid console payload")
    import uuid
    server = str(uuid.UUID(payload["server"]))
    command = payload["command"]
    if not isinstance(command, str) or not command or len(command) > 8192 or any(c in command for c in "\r\n\0"):
        raise SystemExit("invalid console command")
    blocking = [] if command in RIGHT_REMOVALS else guarded_blocking(infra, restart_loader, cache)
    if blocking:
        print(json.dumps({"accepted": False, "refused": "real-or-unresolved-players", "count": len(blocking)}))
        return
    panel = json.loads((infra / "panel-transport.json").read_text(encoding="utf-8"))["panel_origin"]
    key = next((line.split("=", 1)[1].strip() for line in Path(sources["secret_references"]["pterodactyl_keys"]).read_text(encoding="utf-8").splitlines() if line.strip().startswith("key=")), None)
    if not key:
        raise SystemExit("missing AA-Main client key")
    request = urllib.request.Request(panel.rstrip("/") + "/api/client/servers/" + server + "/command",
        data=json.dumps({"command": command}).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "application/json"})
    with (opener or panel_transport.urlopen)(request, timeout=30) as response:
        print(json.dumps({"accepted": 200 <= response.status < 300, "httpStatus": response.status}))


if __name__ == "__main__":
    main()
