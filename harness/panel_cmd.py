"""Console consumer of AA-Main's verified transport. JSON stdin, never a shell command."""
import json
import sys
import urllib.request
from pathlib import Path


def main():
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
    panel = json.loads((infra / "panel-transport.json").read_text(encoding="utf-8"))["panel_origin"]
    key = next((line.split("=", 1)[1].strip() for line in Path(sources["secret_references"]["pterodactyl_keys"]).read_text(encoding="utf-8").splitlines() if line.strip().startswith("key=")), None)
    if not key:
        raise SystemExit("missing AA-Main client key")
    request = urllib.request.Request(panel.rstrip("/") + "/api/client/servers/" + server + "/command",
        data=json.dumps({"command": command}).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "application/json"})
    with panel_transport.urlopen(request, timeout=30) as response:
        print(json.dumps({"accepted": 200 <= response.status < 300, "httpStatus": response.status}))


if __name__ == "__main__":
    main()
