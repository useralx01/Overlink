from __future__ import annotations
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

MODULE = pathlib.Path(__file__).resolve().parents[1] / "agent" / "vyrmesh_tasks.py"
spec = importlib.util.spec_from_file_location("vyrmesh_tasks", MODULE)
tasks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tasks)

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vyrmesh-")
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "demo.py").write_text("def hello():\n    return 'before'\n", encoding="utf-8")
    def run_steps(self, *steps, write=False, tests=False, **params):
        return tasks.workflow({"root": str(self.root), "steps": list(steps),
                               "allow_write": write, "allow_tests": tests, **params})
    def step(self, name, op, **args):
        return {"id": name, "op": op, **args}
    def test_parallel_reads_and_dependencies(self):
        result = self.run_steps(
            self.step("a", "read", path="src/demo.py"),
            self.step("b", "search", query="hello", directory="src"),
            self.step("c", "symbols", path="src/demo.py", depends_on=["a"]))
        self.assertTrue(result["workflow_ok"])
        self.assertEqual(result["results"]["b"]["result"]["matches"][0]["line"], 1)
        self.assertEqual(result["results"]["c"]["result"]["symbols"][0]["name"], "hello")
    def test_snapshot_manifest_and_context(self):
        r = self.run_steps(
            self.step("manifest", "manifest", directory="src"),
            self.step("context", "context", paths=["src/demo.py"]))
        self.assertEqual(r["results"]["manifest"]["result"]["count"], 1)
        self.assertIn("hello", r["results"]["context"]["result"]["files"][0]["excerpt"])
    def test_atomic_patch_and_verified_rollback(self):
        path = self.root / "src" / "demo.py"
        original = path.read_bytes()
        result = self.run_steps(self.step("patch", "replace", path="src/demo.py",
                              expected_sha256=hashlib.sha256(original).hexdigest(),
                              find="before", replace="after"), write=True)
        self.assertTrue(result["workflow_ok"])
        info = result["results"]["patch"]["result"]
        self.assertIn("after", path.read_text())
        restored = self.run_steps(self.step("rollback", "rollback", path="src/demo.py",
                                  backup=info["backup"], expected_sha256=info["after"]), write=True)
        self.assertTrue(restored["workflow_ok"])
        self.assertEqual(path.read_bytes(), original)
    def test_mutations_require_local_permission(self):
        original = (self.root / "src" / "demo.py").read_bytes()
        result = self.run_steps(self.step("patch", "replace", path="src/demo.py",
                                expected_sha256=hashlib.sha256(original).hexdigest(), find="before", replace="after"))
        self.assertFalse(result["workflow_ok"])
        self.assertEqual(result["results"]["patch"]["code"], "permission_denied")
        self.assertEqual((self.root / "src" / "demo.py").read_bytes(), original)
    def test_hash_conflict_prevents_modification(self):
        result = self.run_steps(self.step("patch", "replace", path="src/demo.py",
                                expected_sha256="a"*64, find="before", replace="after"), write=True)
        self.assertEqual(result["results"]["patch"]["code"], "conflict")
        self.assertIn("before", (self.root / "src" / "demo.py").read_text())
    def test_ambiguous_patches_are_rejected(self):
        original = (self.root / "src" / "demo.py").read_bytes()
        result = self.run_steps(self.step("patch", "replace", path="src/demo.py",
                                expected_sha256=hashlib.sha256(original).hexdigest(), find="e", replace="X"), write=True)
        self.assertEqual(result["results"]["patch"]["code"], "ambiguous_patch")
    def test_create_new_file_without_overwrite(self):
        result = self.run_steps(self.step("create", "write", path="src/new.txt", content="Hello"), write=True)
        self.assertTrue(result["workflow_ok"])
        self.assertEqual((self.root / "src" / "new.txt").read_text(), "Hello")
        second = self.run_steps(self.step("create", "write", path="src/new.txt", content="Changed"), write=True)
        self.assertEqual(second["results"]["create"]["code"], "exists")
    def test_rejects_directory_traversal_and_secrets(self):
        for path in ("../escaped.txt", ".env", "src/key.pem", ".git/config"):
            r = self.run_steps(self.step("bad", "read", path=path))
            self.assertEqual(r["results"]["bad"]["code"], "path_denied")
    def test_rejects_symlinks(self):
        outside = self.root / "src" / "demo.py"
        link = self.root / "link.txt"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlink privileges unavailable")
        r = self.run_steps(self.step("bad", "read", path="link.txt"))
        self.assertEqual(r["results"]["bad"]["code"], "path_denied")
    def test_failed_dependency_skips_mutation(self):
        r = self.run_steps(self.step("fail", "read", path="missing.txt"),
                           self.step("write", "write", path="created.txt", content="x",
                                     depends_on=["fail"]), write=True)
        self.assertEqual(r["results"]["write"]["status"], "skipped")
        self.assertFalse((self.root / "created.txt").exists())
    def test_dependency_cycles_rejected(self):
        with self.assertRaisesRegex(tasks.TaskError, "cycle"):
            self.run_steps(self.step("a", "read", path="src/demo.py", depends_on=["b"]),
                           self.step("b", "read", path="src/demo.py", depends_on=["a"]))
    def test_duplicate_ids_rejected(self):
        with self.assertRaises(tasks.TaskError):
            self.run_steps(self.step("a", "read", path="src/demo.py"),
                           self.step("a", "read", path="src/demo.py"))
    def test_test_execution_requires_approval(self):
        r = self.run_steps(self.step("test", "test", runner="python_unittest"))
        self.assertEqual(r["results"]["test"]["code"], "permission_denied")
    def test_only_allowlisted_test_runners(self):
        r = self.run_steps(self.step("test", "test", runner="powershell"),
                           tests=True)
        self.assertEqual(r["results"]["test"]["code"], "test_denied")
    def test_cli_describe(self):
        result = subprocess.run([sys.executable, "-I", str(MODULE), "describe"],
                                input=json.dumps({}).encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        info = json.loads(result.stdout)
        self.assertIn("replace", info["mutation_operations"])
    def test_single_roundtrip_read_hash_patch_and_restore_with_refs(self):
        initial = (self.root / "src" / "demo.py").read_bytes()
        flow = self.run_steps(
            self.step("read", "read", path="src/demo.py"),
            self.step("patch", "replace", path="src/demo.py", find="before", replace="after",
                      expected_sha256={"from_step":"read","field":"sha256"}, depends_on=["read"]),
            self.step("rollback", "rollback", path="src/demo.py",
                      backup={"from_step":"patch","field":"backup"},
                      expected_sha256={"from_step":"patch","field":"after"},
                      depends_on=["patch"]), write=True)
        self.assertTrue(flow["workflow_ok"],flow)
        self.assertEqual((self.root / "src" / "demo.py").read_bytes(),initial)
    def test_references_must_be_dependencies(self):
        r=self.run_steps(
            self.step("scan", "read", path="src/demo.py"),
            self.step("modify", "replace", path="src/demo.py",
                      expected_sha256={"from_step":"scan","field":"sha256"},
                      find="before",replace="after"), write=True)
        self.assertEqual(r["results"]["modify"]["code"],"invalid_reference")
    def test_conditional_step_skips_if_not_matching(self):
        r=self.run_steps(
            self.step("read", "stat", path="src/demo.py"),
            self.step("create", "write", path="created.txt",content="something",
                      depends_on=["read"],
                      when={"step":"read","field":"bytes","equals":999999}),write=True)
        self.assertEqual(r["results"]["create"]["status"],"skipped")
        self.assertFalse((self.root/"created.txt").exists())
    def test_low_memory_mode_reduces_concurrency(self):
        with mock.patch.object(tasks,"system_memory_load_percent",return_value=97):
            r=self.run_steps(self.step("a","read",path="src/demo.py"),
                             self.step("b","stat",path="src/demo.py"),
                             parallelism=4)
        self.assertTrue(r["workflow_ok"])
        self.assertTrue(r["low_memory_mode"])
        self.assertEqual(r["parallelism"],1)
    def test_low_memory_pauses_tests(self):
        with mock.patch.object(tasks,"system_memory_load_percent",return_value=98):
            r=self.run_steps(self.step("test","test",runner="python_unittest"),tests=True)
        self.assertEqual(r["results"]["test"]["code"],"memory_pressure")
    def test_no_input_shell_escape(self):
        r = self.run_steps(self.step("a", "search", query="x; Remove-Item C:\\", directory="src"))
        self.assertTrue(r["workflow_ok"])
        self.assertEqual(r["results"]["a"]["result"]["matches"], [])

if __name__ == "__main__":
    unittest.main()
