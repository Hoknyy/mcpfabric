"""Garde des joueurs réels de panel_cmd.py (clones-restart et transport simulés, aucun réseau)."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("panel_cmd_under_test", HERE / "panel_cmd.py")
PANEL_CMD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANEL_CMD)
SERVER = "76e42702-37ee-489a-a3e2-beaa9cf9845f"


class Refusal(Exception):
    pass


class TechnicalError(Exception):
    pass


def fake_restart(blocking=(), state="running", fail=None):
    calls = []

    def read_proxy_players(client, context):
        calls.append("glist")
        if fail:
            raise fail
        return types.SimpleNamespace(total=len(blocking) + 1)

    return types.SimpleNamespace(
        Refusal=Refusal, TechnicalError=TechnicalError, calls=calls,
        load_sources=lambda: ({}, {}, {}),
        load_clone_context=lambda *a: types.SimpleNamespace(proxy_identifier="5ddd1dcf"),
        PanelClient=lambda config: object(),
        verify_live_proxy=lambda client, context: "mc26-clone-proxy",
        server_state=lambda client, identifier: state,
        read_proxy_players=read_proxy_players,
        classify_players=lambda client, context, snapshot: (["Tikifirst"], list(blocking)),
    )


class Response:
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class PanelCmdGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        infra = root / "infra"
        infra.mkdir()
        (infra / "panel_transport.py").write_text("def urlopen(*a, **k):\n    raise AssertionError('réseau')\n",
                                                  encoding="utf-8")
        (infra / "panel-transport.json").write_text(json.dumps({"panel_origin": "http://panel.test"}), encoding="utf-8")
        keys = root / "keys.txt"
        keys.write_text("key=cle-de-test\n", encoding="utf-8")
        self.sources = root / "sources.json"
        self.sources.write_text(json.dumps({"aa_main_root": str(root),
                                            "secret_references": {"pterodactyl_keys": str(keys)}}), encoding="utf-8")
        self.posts = []

    def tearDown(self):
        sys.modules.pop("panel_transport", None)
        self.tmp.cleanup()

    def run_cmd(self, restart, command="op Hokny"):
        def opener(request, timeout):
            self.posts.append(json.loads(request.data)["command"])
            return Response()
        out = io.StringIO()
        argv, stdin = sys.argv, sys.stdin
        sys.argv = ["panel_cmd.py", "--sources", str(self.sources)]
        sys.stdin = io.StringIO(json.dumps({"server": SERVER, "command": command}))
        try:
            with contextlib.redirect_stdout(out):
                PANEL_CMD.main(restart_loader=lambda infra: restart, opener=opener)
        finally:
            sys.argv, sys.stdin = argv, stdin
        return json.loads(out.getvalue())

    def test_only_disposable_players_lets_the_command_through(self):
        restart = fake_restart()
        self.assertEqual({"accepted": True, "httpStatus": 204}, self.run_cmd(restart))
        self.assertEqual(["op Hokny"], self.posts)
        self.assertEqual(["glist"], restart.calls)

    def test_a_real_player_refuses_before_any_post(self):
        result = self.run_cmd(fake_restart(blocking=["Bob"]))
        self.assertEqual({"accepted": False, "refused": "real-or-unresolved-players", "count": 1}, result)
        self.assertEqual([], self.posts)

    def test_unknown_players_or_a_stopped_proxy_refuse(self):
        for restart in (fake_restart(state="offline"), fake_restart(fail=TechnicalError("glist")),
                        fake_restart(fail=Refusal("identité"))):
            with self.subTest():
                self.assertFalse(self.run_cmd(restart)["accepted"])
        self.assertEqual([], self.posts)


if __name__ == "__main__":
    unittest.main()
