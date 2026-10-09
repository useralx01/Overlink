"""PC Link local journal, explicit project memory, and metadata-only audit.

One request per process: ``python state.py ACTION [--db PATH]`` reads a JSON
object from stdin and emits one JSON object on stdout. No operation is replayed
when an existing job is unfinished. ``job_status(recover=True)`` is only for a
controller startup after all prior executors have stopped.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import time
import unicodedata
import uuid

MAX_INPUT_BYTES = 4 * 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024
MAX_JOURNAL_RESULT_BYTES = 64 * 1024 * 1024
MAX_JOBS = 100_000  # Tombstones are never automatically deleted.
MAX_NOTE_BYTES = 16 * 1024
MAX_NOTES_PER_PROJECT = 200
MAX_NOTES_PER_NAMESPACE = 2000
MAX_AUDIT_ROWS = 10_000
STATES = frozenset(("received", "running", "done", "cancelled", "interrupted"))
FINAL_STATES = frozenset(("done", "cancelled", "interrupted"))
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:@/\\ -]{1,256}\Z")
OPERATION = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,79}\Z")
AUDIT_EVENTS = frozenset((
    "job_received", "job_claimed", "job_done", "job_cancelled", "job_interrupted",
    "permission_allowed", "permission_denied", "connection_started", "connection_stopped",
    "memory_saved", "memory_deleted", "operation_started", "operation_completed",
    "operation_failed", "device_paired", "device_revoked", "controller_started",
    "controller_stopped",
))
AUDIT_FIELDS = frozenset(("event", "job_id", "operation", "state", "capability",
                          "success", "duration_ms", "error_code", "bytes", "device_id"))


class StateError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def json_text(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise StateError("invalid_argument", "The value must be valid JSON.") from None


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def required_text(data, key, maximum=256):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise StateError("invalid_argument", f"{key} must be a nonempty string of at most {maximum} characters.")
    return value


def identifier(data, key):
    value = required_text(data, key)
    if not IDENTIFIER.fullmatch(value):
        raise StateError("invalid_argument", f"{key} contains unsupported characters.")
    return value


def bounded_integer(data, key, default, minimum, maximum):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise StateError("invalid_argument", f"{key} must be an integer between {minimum} and {maximum}.")
    return value


def scope(data, require_project=False):
    namespace = data.get("namespace", "default")
    if not isinstance(namespace, str) or not namespace.strip() or len(namespace) > 256 or "\x00" in namespace:
        raise StateError("invalid_argument", "namespace must be a nonempty string of at most 256 characters.")
    project = data.get("project")
    if project is None and not require_project:
        project = "global"
    if not isinstance(project, str) or not project.strip() or len(project) > 4096 or "\x00" in project:
        raise StateError("invalid_argument", "An explicit, nonempty project is required.")
    # Native gateway supplies the canonical selected root. Do not merge distinct
    # roots by case folding here: non-Windows clients may use case-sensitive paths.
    return namespace, project


def default_db_path():
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "PC Link" / "state.db"
    return Path.home() / ".local" / "share" / "PC Link" / "state.db"


SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS jobs (
  namespace TEXT NOT NULL, job_id TEXT NOT NULL, project TEXT NOT NULL,
  operation TEXT NOT NULL, mutating INTEGER NOT NULL, arguments_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('received','running','done','cancelled','interrupted')),
  claim_hash TEXT, result_json TEXT, result_hash TEXT, result_omitted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, job_id)
);
CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(namespace, updated_at);
CREATE TABLE IF NOT EXISTS memory (
  rowid INTEGER PRIMARY KEY, namespace TEXT NOT NULL, project TEXT NOT NULL,
  memory_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL,
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(namespace, project, memory_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, content, tags_json, content='memory', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
 INSERT INTO memory_fts(rowid,title,content,tags_json) VALUES(new.rowid,new.title,new.content,new.tags_json);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,title,content,tags_json) VALUES('delete',old.rowid,old.title,old.content,old.tags_json);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,title,content,tags_json) VALUES('delete',old.rowid,old.title,old.content,old.tags_json);
 INSERT INTO memory_fts(rowid,title,content,tags_json) VALUES(new.rowid,new.title,new.content,new.tags_json);
END;
CREATE TABLE IF NOT EXISTS audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_namespace ON audit(namespace,audit_id);
PRAGMA user_version=1;
COMMIT;
"""


class Store:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else default_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), timeout=15, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=15000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def _audit(self, namespace, metadata):
        self.db.execute("INSERT INTO audit(namespace,created_at,metadata_json) VALUES(?,?,?)",
                        (namespace, time.time_ns() // 1_000_000, json_text(metadata)))
        # Keep metadata bounded without deleting job identity/status tombstones.
        self.db.execute("DELETE FROM audit WHERE audit_id IN (SELECT audit_id FROM audit ORDER BY audit_id DESC LIMIT -1 OFFSET ?)",
                        (MAX_AUDIT_ROWS,))

    def _job_view(self, row, include_result=True):
        value = {key: row[key] for key in ("job_id", "operation", "state", "created_at", "updated_at")}
        value["mutating"] = bool(row["mutating"])
        value["execute"] = False
        value["uncertain"] = row["state"] in ("running", "interrupted")
        value["result_available"] = row["result_json"] is not None
        if row["result_json"] is not None and include_result:
            value["result"] = json.loads(row["result_json"])
        if row["result_omitted"]:
            value["result_omitted"] = True
        return value

    def job_prepare(self, data):
        namespace, project = scope(data)
        job_id = identifier(data, "job_id")
        operation = required_text(data, "operation", 80)
        if not OPERATION.fullmatch(operation):
            raise StateError("invalid_argument", "operation must be a tool identifier.")
        mutating = data.get("mutating", True)
        if not isinstance(mutating, bool):
            raise StateError("invalid_argument", "mutating must be a boolean.")
        stage = data.get("stage", "claim")
        if stage not in ("claim", "receive"):
            raise StateError("invalid_argument", "stage must be claim or receive.")
        argument_hash = digest(json_text(data.get("arguments", {})))
        now = time.time_ns() // 1_000_000
        with self.transaction():
            row = self.db.execute("SELECT * FROM jobs WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone()
            if row is not None:
                if (row["operation"] != operation or row["project"] != project or
                        bool(row["mutating"]) != mutating or row["arguments_hash"] != argument_hash):
                    raise StateError("job_conflict", "This job ID already represents a different operation or arguments.")
                if row["state"] != "received" or stage == "receive":
                    return self._job_view(row)
            else:
                if self.db.execute("SELECT count(*) FROM jobs").fetchone()[0] >= MAX_JOBS:
                    raise StateError("storage_limit", "The job journal is full; no execution was authorized.")
                self.db.execute("INSERT INTO jobs(namespace,job_id,project,operation,mutating,arguments_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'received',?,?)",
                                (namespace, job_id, project, operation, int(mutating), argument_hash, now, now))
                self._audit(namespace, {"event": "job_received", "job_id": job_id, "operation": operation, "state": "received"})
                if stage == "receive":
                    return self._job_view(self.db.execute("SELECT * FROM jobs WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone())
            claim_token = secrets.token_urlsafe(32)
            self.db.execute("UPDATE jobs SET state='running',claim_hash=?,updated_at=? WHERE namespace=? AND job_id=? AND state='received'",
                            (digest(claim_token), now, namespace, job_id))
            self._audit(namespace, {"event": "job_claimed", "job_id": job_id, "operation": operation, "state": "running"})
            value = self._job_view(self.db.execute("SELECT * FROM jobs WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone())
            value.update(execute=True, uncertain=False, claim_token=claim_token)
            return value

    def job_complete(self, data):
        namespace, _ = scope(data)
        job_id = identifier(data, "job_id")
        claim_token = required_text(data, "claim_token", 256)
        state = data.get("state", "done")
        if state not in FINAL_STATES:
            raise StateError("invalid_argument", "Completion state must be done, cancelled, or interrupted.")
        result_json = json_text(data["result"]) if "result" in data else None
        result_bytes = len(result_json.encode("utf-8")) if result_json is not None else 0
        result_hash = digest(result_json) if result_json is not None else None
        omitted = result_bytes > MAX_RESULT_BYTES
        if omitted:
            result_json = None
        with self.transaction():
            row = self.db.execute("SELECT * FROM jobs WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone()
            if row is None:
                raise StateError("job_not_found", "No journal entry exists for this job.")
            if not row["claim_hash"] or not hmac.compare_digest(row["claim_hash"], digest(claim_token)):
                raise StateError("invalid_claim", "The completion does not hold this job's claim.")
            if row["state"] in FINAL_STATES:
                if row["state"] == state and row["result_hash"] == result_hash:
                    return self._job_view(row)
                raise StateError("job_finalized", "This job is already finalized and cannot be changed.")
            if row["state"] != "running":
                raise StateError("invalid_state", "Only a running job can be completed.")
            if result_json is not None:
                total = self.db.execute("SELECT coalesce(sum(length(CAST(result_json AS BLOB))),0) FROM jobs").fetchone()[0]
                for older in self.db.execute("SELECT namespace,job_id,length(CAST(result_json AS BLOB)) AS size FROM jobs WHERE result_json IS NOT NULL ORDER BY updated_at,job_id").fetchall():
                    if total + result_bytes <= MAX_JOURNAL_RESULT_BYTES:
                        break
                    self.db.execute("UPDATE jobs SET result_json=NULL,result_omitted=1 WHERE namespace=? AND job_id=?",
                                    (older["namespace"], older["job_id"]))
                    total -= older["size"]
            self.db.execute("UPDATE jobs SET state=?,result_json=?,result_hash=?,result_omitted=?,updated_at=? WHERE namespace=? AND job_id=?",
                            (state, result_json, result_hash, int(omitted), time.time_ns() // 1_000_000, namespace, job_id))
            self._audit(namespace, {"event": "job_" + state, "job_id": job_id, "operation": row["operation"], "state": state})
            return self._job_view(self.db.execute("SELECT * FROM jobs WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone())

    def job_status(self, data):
        namespace, _ = scope(data)
        job_id = identifier(data, "job_id") if "job_id" in data else None
        recover = data.get("recover", False)
        if not isinstance(recover, bool):
            raise StateError("invalid_argument", "recover must be a boolean.")
        limit = bounded_integer(data, "limit", 50, 1, 200)
        recovered = 0
        if recover:
            with self.transaction():
                rows = self.db.execute("SELECT job_id,operation FROM jobs WHERE namespace=? AND state IN ('received','running')" + (" AND job_id=?" if job_id else ""),
                                       (namespace, job_id) if job_id else (namespace,)).fetchall()
                for row in rows:
                    self.db.execute("UPDATE jobs SET state='interrupted',updated_at=? WHERE namespace=? AND job_id=?",
                                    (time.time_ns() // 1_000_000, namespace, row["job_id"]))
                    self._audit(namespace, {"event": "job_interrupted", "job_id": row["job_id"], "operation": row["operation"], "state": "interrupted"})
                recovered = len(rows)
        if job_id:
            row = self.db.execute("SELECT * FROM jobs WHERE namespace=? AND job_id=?", (namespace, job_id)).fetchone()
            return {"found": row is not None, "recovered": recovered, **(self._job_view(row) if row else {})}
        rows = self.db.execute("SELECT * FROM jobs WHERE namespace=? ORDER BY updated_at DESC,job_id LIMIT ?", (namespace, limit)).fetchall()
        return {"jobs": [self._job_view(row, include_result=False) for row in rows], "recovered": recovered}

    def audit_append(self, data):
        namespace, _ = scope(data)
        metadata = data.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {key: value for key, value in data.items() if key not in ("namespace", "project", "action")}
        if set(metadata) - AUDIT_FIELDS:
            raise StateError("invalid_argument", "Audit accepts metadata only; command, content, paths, and screen data are not accepted.")
        if metadata.get("event") not in AUDIT_EVENTS:
            raise StateError("invalid_argument", "Unknown audit event.")
        for key, value in metadata.items():
            if key in ("success",):
                if not isinstance(value, bool):
                    raise StateError("invalid_argument", "Audit success must be boolean.")
            elif key in ("duration_ms", "bytes"):
                if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2**53 - 1:
                    raise StateError("invalid_argument", "Audit numeric fields must be nonnegative integers.")
            elif key == "state":
                if value not in STATES:
                    raise StateError("invalid_argument", "Unknown audit state.")
            elif key != "event":
                if not isinstance(value, str) or not (IDENTIFIER if key in ("job_id", "device_id") else OPERATION).fullmatch(value):
                    raise StateError("invalid_argument", "Audit text fields must be identifiers.")
        with self.transaction():
            self._audit(namespace, metadata)
            audit_id = self.db.execute("SELECT last_insert_rowid()").fetchone()[0]
        return {"audit_id": audit_id}

    def audit_read(self, data):
        namespace, _ = scope(data)
        limit = bounded_integer(data, "limit", 50, 1, 200)
        after_id = bounded_integer(data, "after_id", 0, 0, 2**63 - 1)
        rows = self.db.execute("SELECT * FROM audit WHERE namespace=? AND audit_id>? ORDER BY audit_id DESC LIMIT ?", (namespace, after_id, limit)).fetchall()
        return {"entries": [{"audit_id": row["audit_id"], "created_at": row["created_at"], **json.loads(row["metadata_json"])} for row in rows]}

    def memory_put(self, data):
        namespace, project = scope(data, require_project=True)
        memory_id = identifier(data, "memory_id") if "memory_id" in data else str(uuid.uuid4())
        title = required_text(data, "title", 200)
        content = data.get("text", data.get("content"))
        if not isinstance(content, str) or not content.strip() or len(content.encode("utf-8")) > MAX_NOTE_BYTES or "\x00" in content:
            raise StateError("invalid_argument", "Note text must be nonempty and at most 16 KiB.")
        tags = data.get("tags", [])
        if not isinstance(tags, list) or len(tags) > 12 or any(not isinstance(t, str) or not t.strip() or len(t) > 64 or "\x00" in t for t in tags):
            raise StateError("invalid_argument", "tags must contain at most 12 short strings.")
        expected_version = data.get("expected_version")
        if expected_version is not None and (isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0):
            raise StateError("invalid_argument", "expected_version must be a nonnegative integer.")
        now = time.time_ns() // 1_000_000
        with self.transaction():
            row = self.db.execute("SELECT * FROM memory WHERE namespace=? AND project=? AND memory_id=?", (namespace, project, memory_id)).fetchone()
            if expected_version is not None and expected_version != (row["version"] if row else 0):
                raise StateError("memory_conflict", "The note changed since its expected version.")
            if row is None:
                if self.db.execute("SELECT count(*) FROM memory WHERE namespace=? AND project=?", (namespace, project)).fetchone()[0] >= MAX_NOTES_PER_PROJECT:
                    raise StateError("storage_limit", "This project has reached its saved-note limit.")
                if self.db.execute("SELECT count(*) FROM memory WHERE namespace=?", (namespace,)).fetchone()[0] >= MAX_NOTES_PER_NAMESPACE:
                    raise StateError("storage_limit", "This device has reached its saved-note limit.")
                self.db.execute("INSERT INTO memory(namespace,project,memory_id,title,content,tags_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
                                (namespace, project, memory_id, title, content, json_text(tags), now, now))
                version = 1
            else:
                version = row["version"] + 1
                self.db.execute("UPDATE memory SET title=?,content=?,tags_json=?,version=?,updated_at=? WHERE rowid=?", (title, content, json_text(tags), version, now, row["rowid"]))
            self._audit(namespace, {"event": "memory_saved", "operation": "memory_put"})
        return {"memory_id": memory_id, "version": version, "saved": True}

    def memory_search(self, data):
        namespace, project = scope(data, require_project=True)
        query = data.get("query", "")
        if not isinstance(query, str) or len(query) > 1000 or "\x00" in query:
            raise StateError("invalid_argument", "query must be a string of at most 1000 characters.")
        limit = bounded_integer(data, "limit", 8, 1, 20)
        budget = bounded_integer(data, "max_chars", 12_000, 256, 64_000)
        memory_id = identifier(data, "memory_id") if "memory_id" in data else None
        tokens = re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", query), flags=re.UNICODE)[:20]
        if memory_id:
            rows = self.db.execute("SELECT * FROM memory WHERE namespace=? AND project=? AND memory_id=?", (namespace, project, memory_id)).fetchall()
        elif tokens:
            # Treat user input as plain terms, never as executable FTS operators.
            expression = " OR ".join('"' + token.replace('"', '""') + '"*' for token in tokens)
            rows = self.db.execute("SELECT m.*,snippet(memory_fts,1,'','', ' … ',40) AS excerpt FROM memory_fts JOIN memory m ON m.rowid=memory_fts.rowid WHERE memory_fts MATCH ? AND m.namespace=? AND m.project=? ORDER BY bm25(memory_fts),m.updated_at DESC LIMIT ?",
                                   (expression, namespace, project, limit)).fetchall()
        else:
            rows = self.db.execute("SELECT * FROM memory WHERE namespace=? AND project=? ORDER BY updated_at DESC,rowid DESC LIMIT ?", (namespace, project, limit)).fetchall()
        entries = []
        for row in rows:
            if budget <= 0:
                break
            text = row["content"][:budget]
            budget -= len(text)
            value = {key: row[key] for key in ("memory_id", "title", "version", "created_at", "updated_at")}
            value.update(text=text, tags=json.loads(row["tags_json"]), truncated=len(text) < len(row["content"]))
            if "excerpt" in row.keys():
                value["excerpt"] = row["excerpt"][:1000]
            entries.append(value)
        return {"entries": entries, "project": project, "truncated": len(entries) < len(rows) or any(e["truncated"] for e in entries)}

    def memory_delete(self, data):
        namespace, project = scope(data, require_project=True)
        memory_id = identifier(data, "memory_id")
        expected_version = data.get("expected_version")
        if expected_version is not None and (isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0):
            raise StateError("invalid_argument", "expected_version must be a nonnegative integer.")
        with self.transaction():
            row = self.db.execute("SELECT version FROM memory WHERE namespace=? AND project=? AND memory_id=?", (namespace, project, memory_id)).fetchone()
            if expected_version is not None and expected_version != (row["version"] if row else 0):
                raise StateError("memory_conflict", "The note changed since its expected version.")
            changed = self.db.execute("DELETE FROM memory WHERE namespace=? AND project=? AND memory_id=?", (namespace, project, memory_id)).rowcount
            if changed:
                self._audit(namespace, {"event": "memory_deleted", "operation": "memory_delete"})
        return {"deleted": bool(changed), "memory_id": memory_id}


ACTIONS = ("job_prepare", "job_complete", "job_status", "audit_append", "audit_read", "memory_put", "memory_search", "memory_delete")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=ACTIONS, nargs="?")
    parser.add_argument("--db", help="Override the local database path (normally not needed).")
    options = parser.parse_args(argv)
    store = None
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise StateError("input_too_large", "Request exceeds the local state input limit.")
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
            raise StateError("invalid_json", "Input must be one UTF-8 JSON object.") from None
        if not isinstance(data, dict):
            raise StateError("invalid_argument", "Input must be a JSON object.")
        action = options.action or data.get("action")
        if action not in ACTIONS:
            raise StateError("invalid_argument", "Unknown local state action.")
        store = Store(options.db)
        result = getattr(store, action)(data)
        output = {"ok": True, **result}
        exit_code = 0
    except StateError as exc:
        output = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
        exit_code = 1
    except sqlite3.OperationalError as exc:
        code = "database_busy" if "locked" in str(exc).lower() else "database_error"
        output = {"ok": False, "error": {"code": code, "message": "The local state database could not complete the request."}}
        exit_code = 1
    except (OSError, sqlite3.DatabaseError, ValueError, TypeError, OverflowError):
        output = {"ok": False, "error": {"code": "state_error", "message": "The local state request could not be completed."}}
        exit_code = 1
    finally:
        if store is not None:
            store.close()
    sys.stdout.buffer.write((json_text(output) + "\n").encode("utf-8"))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
