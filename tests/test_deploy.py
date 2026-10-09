"""Bounded local tests; never contact agent-server."""

import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy.sh"


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "deploy.sh must exist")
        self.deploy = runpy.run_path(str(SCRIPT))
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "commit", "--allow-empty", "-qm", "Base")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout.strip()

    def put(self, path, content):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)

    def test_snapshot_whitelist_and_dirty_source_manifest(self):
        allowed = {
            "src/index.ts": "export const value = 2;\n",
            "tests/unit-example.mjs": "// test fixture\n",
            "package.json": "{}\n",
            "package-lock.json": '{"lockfileVersion": 3}\n',
            "README.md": "Readme\n",
            "CHANGELOG.md": "Changes\n",
        }
        for path, content in allowed.items():
            self.put(path, content)
        for path in ["PLAN.md", "AGENTS.md", ".env", "auth.json",
                     "node_modules/example/index.js", "tests/.env.test",
                     "src/.credentials.json", "tests/node_modules/leak.js", "tests/PLAN.md"]:
            self.put(path, "must not transfer")
        # Even tracked credential files must stay local.
        self.git("add", "src/.credentials.json", "tests/.env.test")
        stage = self.root / "stage"
        manifest = self.deploy["create_snapshot"](self.repo, stage)
        self.assertEqual(manifest["base_git_revision"], self.git("rev-parse", "HEAD"))
        self.assertTrue(manifest["dirty"])
        self.assertEqual(manifest["files"], {
            path: hashlib.sha256(content.encode()).hexdigest()
            for path, content in allowed.items()
        })
        self.assertEqual(json.loads((stage / "deployment-manifest.json").read_text()), manifest)
        self.assertEqual({str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file()},
                         set(allowed) | {"deployment-manifest.json"})
        for path, content in allowed.items():
            self.assertEqual((stage / path).read_text(), content)

    def test_snapshot_rejects_symlink_outside_source(self):
        self.put("package-lock.json", "{}")
        self.put("secret", "private")
        (self.repo / "src").mkdir()
        (self.repo / "src/leak.ts").symlink_to(self.repo / "secret")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.deploy["create_snapshot"](self.repo, self.root / "stage")


if __name__ == "__main__":
    unittest.main()
