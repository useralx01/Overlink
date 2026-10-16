from __future__ import annotations

import argparse
import ast
import concurrent.futures
import ctypes
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone

MAX_INPUT = 900_000
MAX_OUTPUT = 160_000
MAX_STEPS = 24
MAX_FILE = 260_000
READ_OPS = frozenset(("read", "stat", "list", "search", "symbols", "git_status", "git_diff", "manifest", "context"))
MUTATING_OPS = frozenset(("replace", "write", "rollback", "test"))
ALLOWED_OPS = READ_OPS | MUTATING_OPS
EXCLUDED = frozenset((".git", ".venv", "node_modules", "__pycache__", "dist", "build", ".overlink-backups"))
BLOCKED_NAMES = frozenset((".env", "id_rsa", "id_ed25519", "device.bin", "credentials.json", "runtime.json"))
BLOCKED_SUFFIX = frozenset((".key", ".pem", ".p12", ".pfx"))
TEST_COMMANDS = {
    "python_unittest": [sys.executable, "-m", "unittest", "discover"],
    "python_pytest": [sys.executable, "-m", "pytest", "-q"],
    "node_test": [os.environ.get("PC_LINK_NODE") or shutil.which("node") or "node", "--test"],
    "npm_test": ["npm", "test", "--", "--run"],
}

class TaskError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

def text(value, limit=200, field="value"):
    if not isinstance(value, str) or not value or len(value) > limit or "\0" in value:
        raise TaskError("invalid_argument", f"{field} must be a nonempty bounded string")
    return value

def number(value, default, low, high):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise TaskError("invalid_argument", f"integer must be between {low} and {high}")
    return value

def root_path(data):
    root = pathlib.Path(text(data.get("root"), 4096, "root")).resolve(strict=True)
    if not root.is_dir():
        raise TaskError("not_directory", "Shared project root must be a directory")
    return root

def resolve(root, relative, must_exist=True):
    raw = text(relative, 1500, "path")
    target = pathlib.Path(raw)
    if target.is_absolute() or ":" in raw or "\\" in raw or raw.startswith("/"):
        raise TaskError("path_denied", "Only forward-slash project-relative paths are supported")
    if any(part in ("..", ".git", ".overlink-backups") for part in target.parts):
        raise TaskError("path_denied", "Path leaves the approved project or is restricted")
    if any(part in EXCLUDED for part in target.parts):
        raise TaskError("path_denied", "Build, dependency, and hidden system directories are excluded")
    if target.name.lower() in BLOCKED_NAMES or target.suffix.lower() in BLOCKED_SUFFIX:
        raise TaskError("path_denied", "Credential-like files are not exposed by the workflow engine")
    current = root
    for part in target.parts:
        current = current / part
        if current.is_symlink():
            raise TaskError("path_denied", "Symlinks and junctions are not supported")
    result = current.resolve(strict=False)
    try:
        result.relative_to(root)
    except ValueError:
        raise TaskError("path_denied", "Path leaves the approved project") from None
    if must_exist and not result.exists():
        raise TaskError("not_found", "Requested project file does not exist")
    return result

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def safe_read(path):
    if not path.is_file():
        raise TaskError("not_file", "Expected a regular file")
    if path.stat().st_size > MAX_FILE:
        raise TaskError("file_too_large", f"Files over {MAX_FILE} bytes require a different file tool")
    return path.read_bytes()

def clip(value, limit=15000):
    value = str(value)
    return value if len(value) <= limit else value[:limit] + "\n[truncated]"

def safe_relative(root, path):
    return path.relative_to(root).as_posix()

def iter_files(root, directory):
    seen = 0
    for base, dirs, files in os.walk(directory, followlinks=False):
        dirs[:] = sorted([d for d in dirs if d not in EXCLUDED and not (pathlib.Path(base) / d).is_symlink()])[:250]
        for name in sorted(files):
            if name.lower() in BLOCKED_NAMES or pathlib.Path(name).suffix.lower() in BLOCKED_SUFFIX:
                continue
            seen += 1
            if seen > 500:
                return
            path = pathlib.Path(base) / name
            if path.is_symlink() or not path.is_file():
                continue
            yield path

def search(root, step):
    directory = resolve(root, step.get("directory") or ".", True)
    if not directory.is_dir():
        raise TaskError("not_directory", "Search directory must exist")
    query = text(step.get("query"), 250, "query")
    case = bool(step.get("case_sensitive", False))
    needle = query if case else query.lower()
    results, scanned, truncated = [], 0, False
    for path in iter_files(root, directory):
        scanned += 1
        if path.stat().st_size > MAX_FILE:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line_no, line in enumerate(source.splitlines(), 1):
            compare = line if case else line.lower()
            if needle in compare:
                results.append({"path": safe_relative(root, path), "line": line_no, "text": clip(line.strip(), 240)})
                if len(results) >= 70:
                    truncated = True
                    break
        if truncated:
            break
    return {"matches": results, "scanned_files": scanned, "truncated": truncated}

def symbols(root, step):
    file = resolve(root, step.get("path"))
    if file.suffix.lower() != ".py":
        raise TaskError("unsupported_language", "Local AST symbols currently support Python files")
    source = safe_read(file).decode("utf-8")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return {"syntax_error": f"{exc.msg} at line {exc.lineno}", "symbols": []}
    result = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            result.append({"name": node.name, "kind": type(node).__name__, "line": node.lineno})
        if len(result) >= 120:
            break
    return {"symbols": result, "truncated": len(result) >= 120}

def git(root, action, step):
    base = ["git", "-C", str(root), "-c", "core.pager=cat"]
    args = ["status", "--porcelain=v1", "-uno"] if action == "git_status" else ["diff", "--no-ext-diff", "--", "."]
    cmd = base + args
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=7, shell=False, check=False)
    except (subprocess.SubprocessError, OSError) as exc:
        raise TaskError("git_unavailable", "Git inspection is unavailable") from exc
    return {"exit_code": result.returncode, "stdout": clip(result.stdout.decode("utf-8", "replace"), 17000),
            "stderr": clip(result.stderr.decode("utf-8", "replace"), 1500)}

def manifest(root, step):
    directory = resolve(root, step.get("directory") or ".", True)
    if not directory.is_dir():
        raise TaskError("not_directory", "Expected a directory")
    files, total = [], 0
    for path in iter_files(root, directory):
        if path.stat().st_size > MAX_FILE:
            continue
        raw = safe_read(path)
        files.append({"path": safe_relative(root, path), "bytes": len(raw), "sha256": digest(raw)})
        total += len(raw)
        if len(files) >= 120:
            break
    return {"files": files, "count": len(files), "bytes": total, "truncated": len(files) >= 120}

def atomic_write(path, content, allow_overwrite):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not allow_overwrite and path.exists():
        raise TaskError("exists", "File already exists")
    fd, temp = tempfile.mkstemp(prefix=".vyrmesh-write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def backup(root, path, previous):
    folder = root / ".overlink-backups" / datetime.now(timezone.utc).strftime("%Y%m%d")
    folder.mkdir(parents=True, exist_ok=True)
    name = str(uuid.uuid4()) + ".bak"
    copy = folder / name
    atomic_write(copy, previous, False)
    return safe_relative(root, copy)

def run_test(root, step):
    runner = text(step.get("runner"), 32, "runner")
    if runner not in TEST_COMMANDS:
        raise TaskError("test_denied", "Only named test runners are available")
    timeout = number(step.get("timeout_seconds"), 20, 2, 45)
    if runner == "npm_test" and not (root / "package.json").is_file():
        raise TaskError("test_denied", "npm test requires a local package.json")
    started = time.perf_counter()
    try:
        done = subprocess.run(TEST_COMMANDS[runner], cwd=str(root), capture_output=True,
                              timeout=timeout, check=False, shell=False)
        return {"runner": runner, "exit_code": done.returncode,
                "stdout": clip(done.stdout.decode("utf-8", "replace"), 11000),
                "stderr": clip(done.stderr.decode("utf-8", "replace"), 2500),
                "seconds": round(time.perf_counter() - started, 3)}
    except subprocess.TimeoutExpired:
        return {"runner": runner, "timed_out": True, "seconds": round(time.perf_counter() - started, 3)}
    except OSError as exc:
        raise TaskError("runner_missing", "Selected test runner is unavailable") from exc

def execute_step(root, step, allow_write, allow_tests):
    op = step["op"]
    if op == "read":
        path = resolve(root, step.get("path"))
        data = safe_read(path)
        try:
            text_value = data.decode("utf-8", "strict")
        except UnicodeDecodeError:
            raise TaskError("not_text", "Only UTF-8 text can be read in this workflow")
        return {"path": safe_relative(root, path), "content": clip(text_value, 14000),
                "sha256": digest(data), "bytes": len(data), "truncated": len(text_value) > 14000}
    if op == "stat":
        path = resolve(root, step.get("path"))
        st = path.stat()
        return {"path": safe_relative(root, path), "bytes": st.st_size, "modified_ns": st.st_mtime_ns,
                "sha256": digest(safe_read(path)) if path.is_file() and st.st_size <= MAX_FILE else None}
    if op == "list":
        path = resolve(root, step.get("path") or ".")
        if not path.is_dir():
            raise TaskError("not_directory", "Expected directory")
        entries = [{"name": p.name, "directory": p.is_dir()} for p in sorted(path.iterdir())
                   if not p.is_symlink() and p.name not in EXCLUDED and p.name.lower() not in BLOCKED_NAMES]
        return {"entries": entries[:120], "truncated": len(entries) > 120}
    if op == "search":
        return search(root, step)
    if op == "symbols":
        return symbols(root, step)
    if op in ("git_status", "git_diff"):
        return git(root, op, step)
    if op == "manifest":
        return manifest(root, step)
    if op == "context":
        paths = step.get("paths")
        if not isinstance(paths, list) or len(paths) > 6:
            raise TaskError("invalid_argument", "Select up to six context paths")
        contents, budget = [], 45000
        for item in paths:
            p = resolve(root, item)
            raw = safe_read(p)
            readable = raw.decode("utf-8", "replace")[: min(budget, 8000)]
            budget -= len(readable)
            contents.append({"path": item, "sha256": digest(raw), "excerpt": readable})
            if budget <= 0:
                break
        return {"files": contents}
    if op == "test":
        if not allow_tests:
            raise TaskError("permission_denied", "Approved test execution is disabled on this device")
        return run_test(root, step)
    if op in ("write", "replace", "rollback"):
        if not allow_write:
            raise TaskError("permission_denied", "File writing is disabled on this device")
        path = resolve(root, step.get("path"), False)
        if path.exists() and not path.is_file():
            raise TaskError("not_file", "Expected a normal file")
        if op == "write":
            if path.exists():
                raise TaskError("exists", "Use replace with a content hash for existing files")
            payload = step.get("content")
            if not isinstance(payload, str) or len(payload.encode("utf-8")) > MAX_FILE:
                raise TaskError("invalid_argument", "Content must be bounded UTF-8")
            atomic_write(path, payload.encode("utf-8"), False)
            return {"path": safe_relative(root, path), "sha256": digest(payload.encode("utf-8")), "created": True}
        if op == "replace":
            old = safe_read(path)
            expected = text(step.get("expected_sha256"), 64, "expected_sha256")
            if digest(old) != expected:
                raise TaskError("conflict", "File contents changed; refresh before editing")
            find = text(step.get("find"), 8000, "find")
            replace = step.get("replace")
            if not isinstance(replace, str) or len(replace) > 15000:
                raise TaskError("invalid_argument", "Replacement must be bounded text")
            original = old.decode("utf-8", "strict")
            if original.count(find) != 1:
                raise TaskError("ambiguous_patch", "Expected exactly one occurrence of the original text")
            new_bytes = original.replace(find, replace, 1).encode("utf-8")
            if len(new_bytes) > MAX_FILE:
                raise TaskError("file_too_large", "Edited file exceeds the workflow file size limit")
            checkpoint = backup(root, path, old)
            atomic_write(path, new_bytes, True)
            return {"path": safe_relative(root, path), "before": digest(old), "after": digest(new_bytes), "backup": checkpoint}
        if op == "rollback":
            previous = text(step.get("backup"), 250, "backup")
            raw = pathlib.Path(previous)
            if raw.is_absolute() or len(raw.parts) != 3 or raw.parts[0] != ".overlink-backups" or not raw.name.endswith(".bak"):
                raise TaskError("path_denied", "Only VyrMesh backup identifiers are valid")
            checkpoint = root / raw
            if checkpoint.is_symlink() or not checkpoint.is_file():
                raise TaskError("not_found", "Backup not found")
            expected = text(step.get("expected_sha256"), 64, "expected_sha256")
            current = safe_read(path)
            if digest(current) != expected:
                raise TaskError("conflict", "File has changed since the backup was created")
            previous_data = safe_read(checkpoint)
            atomic_write(path, previous_data, True)
            return {"path": safe_relative(root, path), "restored_sha256": digest(previous_data)}
    raise TaskError("unknown_operation", "Unsupported local workflow operation")

def step_value(outcomes, step, value):
    if not isinstance(value, dict) or set(value) != {"from_step", "field"}:
        return value
    source=value.get("from_step")
    field=value.get("field")
    if not isinstance(source,str) or source not in step["depends_on"]:
        raise TaskError("invalid_reference","Referenced step must be a completed explicit dependency")
    if not isinstance(field,str) or len(field)>80:
        raise TaskError("invalid_reference","Invalid referenced result field")
    result=outcomes.get(source)
    if result is None or result.get("status")!="ok":
        raise TaskError("invalid_reference","Referenced step did not succeed")
    data=result.get("result")
    if not isinstance(data,dict) or field not in data:
        raise TaskError("invalid_reference","Referenced field does not exist")
    returned=data[field]
    if not isinstance(returned,(str,bool,int,float)) or len(str(returned))>15000:
        raise TaskError("invalid_reference","Only bounded scalar results can be referenced")
    return returned

def system_memory_load_percent():
    if sys.platform != "win32":
        return None
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length",ctypes.c_ulong),("load",ctypes.c_ulong),
                    ("total",ctypes.c_ulonglong),("available",ctypes.c_ulonglong),
                    ("total_page",ctypes.c_ulonglong),("available_page",ctypes.c_ulonglong),
                    ("total_virtual",ctypes.c_ulonglong),("available_virtual",ctypes.c_ulonglong),
                    ("extended",ctypes.c_ulonglong)]
    status=MemoryStatus()
    status.length=ctypes.sizeof(status)
    try:
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.load)
    except (AttributeError,OSError,ValueError):
        pass
    return None

def workflow(data):
    root = root_path(data)
    steps = data.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise TaskError("invalid_argument", "Provide between 1 and 24 workflow steps")
    allow_write = data.get("allow_write") is True
    allow_tests = data.get("allow_tests") is True
    concurrency = number(data.get("parallelism"), 4, 1, 4)
    memory_load = system_memory_load_percent()
    low_memory = memory_load is not None and memory_load >= 90
    if low_memory:
        concurrency = 1
    normalized, names = {}, set()
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise TaskError("invalid_argument", "Steps must be objects")
        name = text(step.get("id"), 50, "id")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}", name) or name in names:
            raise TaskError("invalid_argument", "Step IDs must be unique identifiers")
        names.add(name)
        op = text(step.get("op"), 25, "op")
        if op not in ALLOWED_OPS:
            raise TaskError("unknown_operation", "Unsupported operation: " + op)
        deps = step.get("depends_on", [])
        if not isinstance(deps, list) or len(deps) > MAX_STEPS or any(not isinstance(x, str) for x in deps):
            raise TaskError("invalid_argument", "depends_on must be a list of step IDs")
        normalized[name] = {**step, "depends_on": deps, "id": name, "op": op}
    for step in normalized.values():
        if any(dep not in names or dep == step["id"] for dep in step["depends_on"]):
            raise TaskError("invalid_argument", "Missing or self-referential dependency")
    seen, outcomes, order = set(), {}, []
    started = time.perf_counter()
    budget_seconds = number(data.get("budget_seconds"), 45, 1, 50)
    while len(seen) < len(steps):
        ready = [step for name, step in normalized.items()
                 if name not in seen and all(dep in seen for dep in step["depends_on"])]
        if not ready:
            raise TaskError("dependency_cycle", "Workflow contains a dependency cycle")
        if time.perf_counter() - started > budget_seconds:
            for name in normalized:
                if name not in seen:
                    outcomes[name] = {"status": "skipped", "reason": "workflow time budget exceeded"}
                    seen.add(name)
            break
        blocked = [step for step in ready if any(outcomes[dep]["status"] != "ok" for dep in step["depends_on"])]
        for step in blocked:
            outcomes[step["id"]] = {"status": "skipped", "reason": "dependency failed"}
            seen.add(step["id"])
            order.append(step["id"])
        todo = [step for step in ready if step not in blocked]
        readers = [step for step in todo if step["op"] in READ_OPS]
        writers = [step for step in todo if step["op"] in MUTATING_OPS]
        def one(step):
            begin = time.perf_counter()
            try:
                condition=step.get("when")
                if condition is not None:
                    if not isinstance(condition,dict) or set(condition)!={"step","field","equals"}:
                        raise TaskError("invalid_condition","when requires step, field, equals")
                    value_to_check=step_value(outcomes,step,{"from_step":condition["step"],"field":condition["field"]})
                    if value_to_check!=condition["equals"]:
                        return {"status":"skipped","reason":"condition did not match","ms":0}
                resolved={name:step_value(outcomes,step,value) for name,value in step.items() if name!="when"}
                if memory_load is not None and memory_load>=95 and resolved["op"]=="test":
                    raise TaskError("memory_pressure","Tests are paused under critical RAM pressure; inspect PC health first")
                value = execute_step(root, resolved, allow_write, allow_tests)
                result = {"status": "ok", "result": value}
            except TaskError as exc:
                result = {"status": "error", "code": exc.code, "message": str(exc)}
            except (OSError, UnicodeError, ValueError, subprocess.SubprocessError) as exc:
                result = {"status": "error", "code": "execution_failed", "message": str(exc)[:220]}
            return {**result, "ms": round((time.perf_counter() - begin) * 1000, 2)}
        if readers:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(concurrency,len(readers))) as pool:
                values = list(pool.map(one, readers))
            for step, value in zip(readers, values):
                outcomes[step["id"]] = value
                seen.add(step["id"])
                order.append(step["id"])
        for step in writers:
            outcomes[step["id"]] = one(step)
            seen.add(step["id"])
            order.append(step["id"])
    ok = all(value["status"] == "ok" for value in outcomes.values())
    return {"ok": True, "workflow_ok": ok, "results": {name: outcomes[name] for name in order},
            "steps": len(steps), "parallelism": concurrency, "memory_load_percent": memory_load,
            "low_memory_mode": low_memory,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2)}

def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("execute", "describe"))
    options = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise TaskError("too_large", "Workflow input exceeded size limit")
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise TaskError("invalid_argument", "Expected workflow object")
        if options.action == "execute":
            result = workflow(data)
        else:
            result = {"ok": True, "max_steps": MAX_STEPS, "max_parallel": 4,
                      "read_only_operations": sorted(READ_OPS),
                      "mutation_operations": sorted(MUTATING_OPS),
                      "test_runners": sorted(TEST_COMMANDS)}
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_OUTPUT:
            result = {"ok": True, "workflow_ok": False, "error": {"code": "output_too_large",
                      "message": "Workflow result exceeds response budget; narrow the steps."}}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except TaskError as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": str(exc)}}))
        return 1
    except (OSError, ValueError, UnicodeError, TypeError) as exc:
        print(json.dumps({"ok": False, "error": {"code": "invalid_workflow", "message": str(exc)[:200]}}))
        return 1

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
