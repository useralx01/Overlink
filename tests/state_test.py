"""Integration tests against the real local SQLite state store and CLI."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "agent" / "state.py"
spec = importlib.util.spec_from_file_location("pc_link_state", SOURCE)
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.db"
        self.store = state.Store(self.path)
        self.scope = {"namespace": "device-1", "project": "C:\\chosen-project"}
        self.job = {**self.scope, "job_id": "job-1", "operation": "run_command", "mutating": True,
                    "arguments": {"command": "Write-Output sensitive-text", "working_directory": "src"}}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_duplicate_running_job_is_not_replayed_after_crash(self):
        claim = self.store.job_prepare(self.job)
        self.assertTrue(claim["execute"])
        self.store.close()
        self.store = state.Store(self.path)
        duplicate = self.store.job_prepare(self.job)
        self.assertFalse(duplicate["execute"])
        self.assertTrue(duplicate["uncertain"])
        self.assertNotIn("claim_token", duplicate)
        recovery = self.store.job_status({**self.scope, "recover": True})
        self.assertEqual(recovery["recovered"], 1)
        self.assertEqual(self.store.job_prepare(self.job)["state"], "interrupted")
        with self.assertRaisesRegex(state.StateError, "already finalized"):
            self.store.job_complete({**self.scope, "job_id": "job-1", "claim_token": claim["claim_token"], "result": {"value": "too late"}})
        self.assertTrue(self.store.job_prepare({**self.job, "job_id": "explicit-new-job"})["execute"])

    def test_done_replay_returns_result_without_execution(self):
        claim = self.store.job_prepare(self.job)
        completion = {**self.scope, "job_id": "job-1", "claim_token": claim["claim_token"], "result": {"exit_code": 0, "unicode": "é漢字"}}
        self.store.job_complete(completion)
        replay = self.store.job_prepare(self.job)
        self.assertFalse(replay["execute"])
        self.assertEqual(replay["result"], completion["result"])
        self.assertEqual(self.store.job_complete(completion)["result"], completion["result"])
        with self.assertRaisesRegex(state.StateError, "already finalized"):
            self.store.job_complete({**completion, "result": {"exit_code": 1}})

    def test_same_id_with_different_operation_args_root_or_kind_rejected(self):
        self.store.job_prepare(self.job)
        for changes in ({"operation": "read_file"}, {"arguments": {"command": "different"}}, {"project": "D:\\other"}, {"mutating": False}):
            with self.subTest(changes=changes), self.assertRaises(state.StateError) as error:
                self.store.job_prepare({**self.job, **changes})
            self.assertEqual(error.exception.code, "job_conflict")

    def test_only_one_concurrent_claim_across_connections(self):
        gate = threading.Barrier(12)
        def claim(_):
            gate.wait(timeout=10)
            local = state.Store(self.path)
            try:
                return local.job_prepare(self.job)
            finally:
                local.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(claim, range(12)))
        self.assertEqual(sum(r["execute"] for r in results), 1)
        self.assertEqual({r["state"] for r in results}, {"running"})

    def test_receive_then_claim_and_cancel(self):
        self.assertEqual(self.store.job_prepare({**self.job, "stage": "receive"})["state"], "received")
        claim = self.store.job_prepare(self.job)
        self.assertTrue(claim["execute"])
        with self.assertRaises(state.StateError) as error:
            self.store.job_complete({**self.scope, "job_id": "job-1", "claim_token": "wrong-token"})
        self.assertEqual(error.exception.code, "invalid_claim")
        self.store.job_complete({**self.scope, "job_id": "job-1", "claim_token": claim["claim_token"], "state": "cancelled"})
        self.assertEqual(self.store.job_prepare(self.job)["state"], "cancelled")

    def test_namespaces_isolate_claims_recovery_and_results(self):
        a = self.store.job_prepare(self.job)
        other = {**self.job, "namespace": "device-2"}
        b = self.store.job_prepare(other)
        self.store.job_status({**self.scope, "recover": True})
        self.assertEqual(self.store.job_prepare(self.job)["state"], "interrupted")
        self.assertEqual(self.store.job_prepare(other)["state"], "running")
        self.store.job_complete({**self.scope, "namespace": "device-2", "job_id": "job-1", "claim_token": b["claim_token"], "result": 42})
        self.assertNotIn("result", self.store.job_status({**self.scope, "job_id": "job-1"}))

    def test_large_results_and_pruning_preserve_job_tombstones(self):
        claim = self.store.job_prepare(self.job)
        with patch.object(state, "MAX_RESULT_BYTES", 10):
            saved = self.store.job_complete({**self.scope, "job_id": "job-1", "claim_token": claim["claim_token"], "result": "x" * 100})
        self.assertTrue(saved["result_omitted"])
        self.assertFalse(self.store.job_prepare(self.job)["execute"])
        for number in range(2, 5):
            job = {**self.job, "job_id": "job-" + str(number)}
            claim = self.store.job_prepare(job)
            with patch.object(state, "MAX_JOURNAL_RESULT_BYTES", 50):
                self.store.job_complete({**self.scope, "job_id": job["job_id"], "claim_token": claim["claim_token"], "result": "x" * 30})
        self.assertFalse(self.store.job_prepare({**self.job, "job_id": "job-2"})["execute"])
        self.assertTrue(self.store.job_status({**self.scope, "job_id": "job-2"})["result_omitted"])

    def note(self, **changes):
        data = {**self.scope, "memory_id": "note-1", "title": "Chosen architecture", "text": "Use SQLite transactions for the persistent job queue.", "tags": ["architecture"]}
        return self.store.memory_put({**data, **changes})

    def test_fts_search_is_scoped_and_delete_removes_index(self):
        self.note()
        self.note(namespace="other-device", text="SQLite secret belonging to another device")
        self.note(project="D:\\other", text="SQLite secret belonging to another project")
        found = self.store.memory_search({**self.scope, "query": "sqlite queue"})
        self.assertEqual(len(found["entries"]), 1)
        self.assertIn("persistent job queue", found["entries"][0]["text"])
        # FTS punctuation/operators remain ordinary text and cannot change scope.
        self.store.memory_search({**self.scope, "query": 'sqlite OR project:* "); DROP TABLE memory; --'})
        self.store.memory_delete({**self.scope, "memory_id": "note-1"})
        self.assertEqual(self.store.memory_search({**self.scope, "query": "sqlite"})["entries"], [])

    def test_memory_update_compare_and_swap_avoids_stale_overwrite(self):
        self.assertEqual(self.note(expected_version=0)["version"], 1)
        self.assertEqual(self.note(expected_version=1, text="Use PostgreSQL instead.")["version"], 2)
        with self.assertRaises(state.StateError) as error:
            self.note(expected_version=1, text="Stale unwanted overwrite.")
        self.assertEqual(error.exception.code, "memory_conflict")
        self.assertEqual(self.store.memory_search({**self.scope, "query": "sqlite"})["entries"], [])
        self.assertEqual(self.store.memory_search({**self.scope, "query": "postgres"})["entries"][0]["version"], 2)
        with self.assertRaises(state.StateError):
            self.store.memory_delete({**self.scope, "memory_id": "note-1", "expected_version": 1})

    def test_memory_requires_explicit_project_and_bounds_storage(self):
        with self.assertRaises(state.StateError):
            self.store.memory_put({"title": "x", "text": "x"})
        with self.assertRaises(state.StateError):
            self.note(text="漢" * state.MAX_NOTE_BYTES)
        with patch.object(state, "MAX_NOTES_PER_PROJECT", 1):
            self.note()
            with self.assertRaises(state.StateError):
                self.note(memory_id="note-2")
            self.note(text="Updating existing note remains allowed.")
        self.note(memory_id="note-2", text="a" * 1000)
        found = self.store.memory_search({**self.scope, "max_chars": 256})
        self.assertLessEqual(sum(len(n["text"]) for n in found["entries"]), 256)
        self.assertTrue(found["truncated"])

    def test_journal_hashes_arguments_and_audit_never_contains_content(self):
        self.store.job_prepare(self.job)
        self.note(text="Private explicit saved note.")
        entries = self.store.audit_read(self.scope)["entries"]
        serialized = json.dumps(entries)
        self.assertNotIn("sensitive-text", serialized)
        self.assertNotIn("Private explicit", serialized)
        self.assertNotIn("chosen-project", serialized)
        row = self.store.db.execute("SELECT * FROM jobs").fetchone()
        self.assertNotIn("sensitive-text", str(tuple(row)))
        for forbidden in ("command", "text", "path", "screen", "arguments", "result"):
            with self.subTest(forbidden=forbidden), self.assertRaises(state.StateError):
                self.store.audit_append({**self.scope, "metadata": {"event": "operation_completed", forbidden: "do not persist"}})
        self.store.audit_append({**self.scope, "metadata": {"event": "operation_completed", "operation": "run_command", "success": True, "duration_ms": 5}})

    def test_audit_is_bounded_and_namespace_filtered(self):
        with patch.object(state, "MAX_AUDIT_ROWS", 3):
            for i in range(5):
                self.store.audit_append({**self.scope, "event": "controller_started", "bytes": i})
            self.store.audit_append({**self.scope, "namespace": "other-device", "event": "controller_stopped"})
        rows = self.store.audit_read(self.scope)["entries"]
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["bytes"] for r in rows}, {3, 4})
        self.assertEqual(len(self.store.audit_read({"namespace": "other-device"})["entries"]), 1)


class CLITests(unittest.TestCase):
    def test_cli_outputs_single_json_and_default_localappdata_database(self):
        with tempfile.TemporaryDirectory() as root:
            env = {**os.environ, "LOCALAPPDATA": root}
            request = {"namespace": "device", "project": "root", "job_id": "cli-job", "operation": "read_file", "mutating": False}
            result = subprocess.run([sys.executable, str(SOURCE), "job_prepare"], input=json.dumps(request).encode(), capture_output=True, env=env, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.count(b"\n"), 1)
            self.assertTrue(json.loads(result.stdout)["execute"])
            self.assertEqual(result.stderr, b"")
            self.assertTrue((Path(root) / "PC Link" / "state.db").is_file())
            bad = subprocess.run([sys.executable, str(SOURCE), "job_status"], input=b"not json", capture_output=True, env=env, timeout=20)
            self.assertEqual(bad.returncode, 1)
            self.assertEqual(json.loads(bad.stdout)["error"]["code"], "invalid_json")
            self.assertEqual(bad.stderr, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
