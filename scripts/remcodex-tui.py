#!/usr/bin/env python3
"""Launch Codex's interactive TUI through a local app-server."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Sequence

BYPASS_FLAGS: list[str] = []


def child_environment() -> dict[str, str]:
    env = os.environ.copy()
    try:
        refs = [item.get("credentialRef") for item in json.loads(env.get("REMCODEX_REMOTE_INSTANCES", "[]"))]
    except (ValueError, TypeError, AttributeError):
        refs = []
    for key in list(env):
        if key.startswith("REMCODEX_") or key in refs:
            env.pop(key, None)
    return env


def resolve_codex(command: str) -> str:
    resolved = shutil.which(command)
    if resolved is None:
        raise FileNotFoundError(f"Codex executable not found: {command}")
    return resolved


def build_app_server_command(codex: str, endpoint: str) -> list[str]:
    return [codex, *BYPASS_FLAGS, "app-server", "--listen", endpoint]


def build_tui_command(codex: str, endpoint: str) -> list[str]:
    return [codex, *BYPASS_FLAGS, "--remote", endpoint]


def is_socket(path: Path) -> bool:
    try:
        return stat.S_ISSOCK(path.stat().st_mode)
    except FileNotFoundError:
        return False


def wait_for_socket(socket_path: Path, process: subprocess.Popen[bytes], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if is_socket(socket_path):
            return
        if process.poll() is not None:
            raise RuntimeError(f"Codex app-server exited before creating {socket_path}")
        time.sleep(0.05)
    raise TimeoutError(f"Timed out waiting for Codex app-server socket: {socket_path}")


def write_registry_metadata(
    path: Path,
    instance_id: str,
    endpoint: str,
    socket_path: Path,
    process: subprocess.Popen[bytes],
) -> None:
    metadata = {
        "id": instance_id,
        "endpoint": endpoint,
        "wsEndpoint": f"ws+unix://{socket_path}:/",
        "socketPath": str(socket_path),
        "pid": process.pid,
        "cwd": os.getcwd(),
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "codex",
    }
    path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")


def terminate(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run_interactive(codex: str, registry_dir: Path, socket_timeout: float) -> int:
    registry_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if registry_dir.is_symlink() or registry_dir.stat().st_uid != os.getuid():
        raise RuntimeError("App-server registry must be owned by the current user.")
    registry_dir.chmod(0o700)

    instance_id = f"codex-{os.getpid()}-{time.time_ns() % 1_000_000_000}"
    socket_path = registry_dir / f"{instance_id}.sock"
    metadata_path = registry_dir / f"{instance_id}.json"
    log_path = registry_dir / f"{instance_id}.log"
    endpoint = f"unix://{socket_path}"

    app_server: subprocess.Popen[bytes] | None = None
    tui: subprocess.Popen[bytes] | None = None
    with log_path.open("ab") as log:
        try:
            app_server = subprocess.Popen(
                build_app_server_command(codex, endpoint),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=child_environment(),
            )
            wait_for_socket(socket_path, app_server, socket_timeout)
            write_registry_metadata(metadata_path, instance_id, endpoint, socket_path, app_server)
            tui = subprocess.Popen(build_tui_command(codex, endpoint), env=child_environment())
            return tui.wait()
        except KeyboardInterrupt:
            return 130
        finally:
            terminate(tui)
            terminate(app_server)
            metadata_path.unlink(missing_ok=True)
            socket_path.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="remcodex-tui",
        description="Run Codex interactively through a discoverable local app-server.",
    )
    parser.add_argument(
        "--codex-command",
        default=os.environ.get("CODEX_COMMAND", "codex"),
        help="Codex executable (default: CODEX_COMMAND or codex).",
    )
    parser.add_argument(
        "--socket-timeout",
        type=float,
        default=5.0,
        help="Seconds to wait for the app-server socket (default: 5).",
    )
    parser.add_argument(
        "--registry-dir",
        default=os.environ.get(
            "CODEX_APP_SERVER_REGISTRY_DIR",
            str(Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/remcodex-{os.getuid()}")) / "codex-app-servers"),
        ),
        help="App-server registry directory.",
    )
    parser.add_argument("codex_args", nargs=argparse.REMAINDER, help="Explicit Codex arguments to pass through.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        codex = resolve_codex(args.codex_command)
        if args.codex_args:
            os.execvpe(codex, [codex, *args.codex_args], os.environ.copy())
        return run_interactive(codex, Path(args.registry_dir), args.socket_timeout)
    except (FileNotFoundError, RuntimeError, TimeoutError) as error:
        print(f"remcodex-tui: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
