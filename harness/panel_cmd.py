"""Send a console command to a Pterodactyl server through the AA-Main verified transport.

Consumer of AA-Main's `panel_transport.py` (single implementation, no divergent copy).
The client API key is read at runtime from the AA-Main secret reference; never stored here.

Usage: python panel_cmd.py --infra <AA-Main/infra> <server_uuid> "<command>"
"""
import json
import sys
import urllib.request
from pathlib import Path

PANEL = "http://146.59.247.201"


def client_key(infra: Path) -> str:
    keys = infra.parent / "secrets" / "pterodactyl-keys.md"
    for line in keys.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("key="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("client key not found in AA-Main secret reference")


def main() -> None:
    args = sys.argv[1:]
    infra = Path(r"C:\.agents\Minecraft\AA-Main\infra")
    if "--infra" in args:
        i = args.index("--infra")
        infra = Path(args[i + 1])
        del args[i : i + 2]
    if len(args) < 2:
        raise SystemExit('usage: panel_cmd.py [--infra <dir>] <server_uuid> "<command>"')
    uuid, command = args[0], args[1]

    sys.path.insert(0, str(infra))
    import panel_transport  # noqa: E402

    body = json.dumps({"command": command}).encode("utf-8")
    req = urllib.request.Request(
        f"{PANEL}/api/client/servers/{uuid}/command",
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + client_key(infra),
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with panel_transport.urlopen(req, timeout=30) as resp:
        print("HTTP", resp.status)


if __name__ == "__main__":
    main()
