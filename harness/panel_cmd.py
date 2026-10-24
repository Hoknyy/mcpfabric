"""Console consumer of AA-Main's verified transport. JSON stdin, never a shell command.

Before any command, no real or unresolved player may be online on the private clone network:
AA-Main's clones-restart.py reads the clone proxy (glist all) and classifies every player as
disposable (disposablePlayerUuids) or blocking. One blocking player refuses the command
(accepted: false), the same rule as AA-Main infra/clones-console.py for writes.
"""
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path


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


def main(restart_loader=load_restart, opener=None):
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
    restart = restart_loader(infra)
    try:
        blocking = blocking_players(restart)
    except (restart.Refusal, restart.TechnicalError, OSError, ValueError, KeyError):
        blocking = ["<players unknown>"]
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
