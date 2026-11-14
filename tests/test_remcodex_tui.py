import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "remcodex-tui.py"
SPEC = importlib.util.spec_from_file_location("remcodex_tui", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class RemcodexTuiTests(unittest.TestCase):
    def test_app_server_command_preserves_approval_defaults(self):
        self.assertEqual(
            MODULE.build_app_server_command("codex", "unix:///tmp/codex.sock"),
            [
                "codex",
                "app-server",
                "--listen",
                "unix:///tmp/codex.sock",
            ],
        )

    def test_tui_command_uses_remote_app_server(self):
        self.assertEqual(
            MODULE.build_tui_command("codex", "unix:///tmp/codex.sock"),
            [
                "codex",
                "--remote",
                "unix:///tmp/codex.sock",
            ],
        )

    def test_registry_metadata_is_discoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata_path = Path(directory) / "codex-test.json"
            process = subprocess.Popen(["true"])
            MODULE.write_registry_metadata(
                metadata_path,
                "codex-test",
                "unix:///tmp/codex-test.sock",
                Path("/tmp/codex-test.sock"),
                process,
            )
            process.wait()
            metadata = json.loads(metadata_path.read_text())
            self.assertEqual(metadata["id"], "codex-test")
            self.assertEqual(metadata["endpoint"], "unix:///tmp/codex-test.sock")
            self.assertEqual(metadata["source"], "codex")


if __name__ == "__main__":
    unittest.main()
