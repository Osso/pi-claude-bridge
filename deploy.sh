#!/usr/bin/env python3
"""Deploy the current source snapshot: ./deploy.sh (no arguments)."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


HOST = "agent-server"
DESTINATION = "/home/osso/Repos/pi-claude-bridge"
TRANSFER_PATHS = [
    "src", "tests", "package.json", "package-lock.json", "README.md", "CHANGELOG.md"
]


def git_output(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


def excluded(path):
    return any(
        part in {
            "node_modules", ".git", "__pycache__", "auth.json", ".credentials.json", "PLAN.md"
        }
        or part.startswith(".env")
        or part.endswith((".pem", ".key"))
        for part in path.parts
    )


def create_snapshot(repo, stage):
    """Hash the exact bytes staged, including non-ignored dirty source files."""
    stage.mkdir(parents=True, exist_ok=True)
    revision = git_output(repo, "rev-parse", "HEAD").strip()
    dirty = bool(git_output(repo, "status", "--porcelain"))
    paths = git_output(
        repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
        "--", *TRANSFER_PATHS
    ).split("\0")
    hashes = {}
    for name in sorted(set(paths) - {""}):
        relative = Path(name)
        if excluded(relative):
            continue
        source = repo / relative
        if source.is_symlink() or any(
            (repo / parent).is_symlink() for parent in relative.parents
        ):
            raise ValueError(f"Refusing symlink in transfer: {name}")
        if not source.exists():
            continue  # Tracked files deleted in the dirty tree are not transferred.
        content = source.read_bytes()
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(source.stat().st_mode & 0o777)
        hashes[name] = hashlib.sha256(content).hexdigest()
    for required in ("package.json", "package-lock.json"):
        if required not in hashes:
            raise ValueError(f"Missing deployment input: {required}")
    manifest = {"base_git_revision": revision, "dirty": dirty, "files": hashes}
    (stage / "deployment-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    return manifest


def main():
    if len(sys.argv) != 1:
        raise ValueError("Usage: ./deploy.sh (fixed host and destination; no arguments)")
    repo = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="pi-claude-bridge-deploy-") as temporary:
        stage = Path(temporary)
        manifest = create_snapshot(repo, stage)
        remote = subprocess.run(
            ["ssh", HOST,
             f"mkdir -p {DESTINATION} && "
             f"if test -f {DESTINATION}/package-lock.json; then "
             f"sha256sum {DESTINATION}/package-lock.json; fi"],
            check=True, capture_output=True, text=True
        ).stdout.strip()
        remote_hash = remote.split()[0] if remote else None
        if remote_hash is not None and (
            len(remote_hash) != 64 or any(c not in "0123456789abcdef" for c in remote_hash)
        ):
            raise ValueError("Invalid package-lock.json hash returned by agent-server")
        subprocess.run(
            ["rsync", "-a", "--", f"{stage}/", f"{HOST}:{DESTINATION}/"],
            check=True
        )
        if remote_hash != manifest["files"]["package-lock.json"]:
            subprocess.run(["ssh", HOST, f"cd {DESTINATION} && npm ci"], check=True)
        print(f"Deployed {len(manifest['files'])} files to {HOST}:{DESTINATION}")
        print(f"Source: {manifest['base_git_revision']} (dirty={manifest['dirty']})")
        print(f"Manifest: {DESTINATION}/deployment-manifest.json")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.rstrip(), file=sys.stderr)
        sys.exit(1)
