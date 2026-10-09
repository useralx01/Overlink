"""Rooted project/Git discovery and bounded Python/TypeScript language queries.

JSON stdin/stdout CLI actions: project_status, git_diff, language_status,
lsp_symbols, lsp_definition. Test commands are suggested, never executed here.
Only the native permission gateway may choose the root or enable LSP execution.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import unquote, urlparse

MAX_INPUT = 2 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_PROCESS_OUTPUT = 2 * 1024 * 1024
MAX_RPC_MESSAGE = 4 * 1024 * 1024
SKIP_DIRS = frozenset((".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build", "target", "bin", "obj", ".next"))
LANGUAGES = {".py": "python", ".pyi": "python", ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".cs": "csharp", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby", ".cpp": "cpp", ".c": "c", ".h": "c", ".html": "html", ".css": "css"}


class ProjectError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def output_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def selected_root(data):
    value = data.get("root", data.get("project"))
    if not isinstance(value, str) or not value.strip() or not Path(value).is_absolute():
        raise ProjectError("invalid_argument", "An absolute selected project root is required.")
    root = Path(value).resolve(strict=True)
    if not root.is_dir():
        raise ProjectError("invalid_argument", "The selected project root must be a directory.")
    return root


def within(root, path):
    try:
        return os.path.commonpath((os.path.normcase(str(root)), os.path.normcase(str(path)))) == os.path.normcase(str(root))
    except ValueError:
        return False


def selected_path(root, value, require_file=True):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ProjectError("invalid_argument", "path must be a project-relative file path.")
    candidate = Path(value)
    path = (candidate if candidate.is_absolute() else root / candidate).resolve(strict=True)
    if not within(root, path):
        raise ProjectError("outside_project", "The requested path is outside the selected root.")
    if require_file and not path.is_file():
        raise ProjectError("invalid_argument", "The requested path must be a file.")
    return path


def integer(data, key, default, minimum=0, maximum=1_000_000):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ProjectError("invalid_argument", f"{key} is out of range.")
    return value


def process_env():
    env = dict(os.environ)
    for name in list(env):
        if name.startswith("GIT_CONFIG_") or name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "PYTHONPATH", "PYTHONHOME"):
            env.pop(name, None)
    env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", GIT_PAGER="cat", PAGER="cat")
    return env


def creation_flags():
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def terminate_tree(proc):
    if proc.poll() is not None:
        return
    if os.name == "nt":
        taskkill = Path(os.environ.get("WINDIR", "C:\\Windows")) / "System32" / "taskkill.exe"
        try:
            subprocess.run([str(taskkill), "/PID", str(proc.pid), "/T", "/F"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, creationflags=creation_flags())
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def run_bounded(argv, cwd, timeout=20, maximum=MAX_PROCESS_OUTPUT):
    proc = subprocess.Popen(argv, cwd=str(cwd), env=process_env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=creation_flags())
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = threading.Event()
    def drain(label, pipe):
        try:
            while True:
                data = pipe.read(8192)
                if not data:
                    break
                keep = maximum - len(chunks[label])
                if keep > 0:
                    chunks[label].extend(data[:keep])
                if len(data) > max(0, keep):
                    truncated.set()
        finally:
            pipe.close()
    threads = [threading.Thread(target=drain, args=(label, pipe), daemon=True) for label, pipe in (("stdout", proc.stdout), ("stderr", proc.stderr))]
    for thread in threads:
        thread.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        terminate_tree(proc)
    for thread in threads:
        thread.join(timeout=5)
    return {"exit_code": proc.returncode, "stdout": chunks["stdout"].decode("utf-8", errors="replace"), "stderr": chunks["stderr"].decode("utf-8", errors="replace"), "truncated": truncated.is_set(), "timed_out": timed_out}


def git_executable():
    configured = os.environ.get("PC_LINK_GIT")
    if configured and Path(configured).is_file():
        return configured
    return shutil.which("git")


def git_command(root, args, maximum=MAX_PROCESS_OUTPUT):
    executable = git_executable()
    if not executable:
        raise ProjectError("tool_unavailable", "Git is not installed or configured.")
    # Status fsmonitor and diff text conversion can execute repository-configured
    # programs. Explicitly disable those pathways for these read-only queries.
    return run_bounded([executable, "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", str(root), *args], root, maximum=maximum)


def git_repository(root):
    if not git_executable():
        return {"available": False, "repository": False}
    result = git_command(root, ["rev-parse", "--show-toplevel"], maximum=16_384)
    if result["exit_code"] != 0:
        return {"available": True, "repository": False, "error": result["stderr"][:1000]}
    repository_root = Path(result["stdout"].strip()).resolve()
    if not within(root, repository_root):
        # Selecting a child folder must not grant access to sibling files via Git.
        return {"available": True, "repository": True, "restricted": True,
                "message": "Select the repository root to inspect its Git state."}
    status = git_command(root, ["status", "--porcelain=v1", "-z", "--branch"], maximum=128_000)
    parts = status["stdout"].split("\x00")
    branch = ""
    files = []
    index = 0
    while index < len(parts):
        item = parts[index]
        index += 1
        if not item:
            continue
        if item.startswith("## "):
            branch = item[3:]
            continue
        if len(item) < 4:
            continue
        entry = {"status": item[:2], "path": item[3:]}
        if (item[0] in "RC" or item[1] in "RC") and index < len(parts):
            entry["original_path"] = parts[index]
            index += 1
        files.append(entry)
        if len(files) >= 1000:
            break
    return {"available": True, "repository": True, "root": str(repository_root), "branch": branch, "files": files,
            "clean": not files, "truncated": status["truncated"] or len(files) >= 1000,
            "error": status["stderr"][:1000] if status["exit_code"] != 0 else None}


def git_diff(data):
    root = selected_root(data)
    repository = git_repository(root)
    if not repository.get("repository") or repository.get("restricted"):
        raise ProjectError("not_repository", repository.get("message", "The selected root is not an accessible Git repository."))
    staged = data.get("staged", False)
    if not isinstance(staged, bool):
        raise ProjectError("invalid_argument", "staged must be a boolean.")
    maximum = integer(data, "max_chars", 120_000, 1000, 500_000)
    args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"]
    if staged:
        args.append("--cached")
    if data.get("path"):
        path = selected_path(root, data["path"], require_file=False)
        args.extend(("--", path.relative_to(root).as_posix()))
    else:
        args.append("--")
    result = git_command(root, args, maximum=maximum)
    return {"diff": result["stdout"][:maximum], "staged": staged, "truncated": result["truncated"],
            "exit_code": result["exit_code"], "error": result["stderr"][:2000], "timed_out": result["timed_out"]}


def read_json_file(root, relative):
    try:
        path = selected_path(root, relative)
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, ProjectError):
        return None


def discover_tests(root):
    runners = []
    package = read_json_file(root, "package.json")
    if isinstance(package, dict) and isinstance(package.get("scripts"), dict):
        manager = "pnpm" if (root / "pnpm-lock.yaml").is_file() else "yarn" if (root / "yarn.lock").is_file() else "npm"
        for label in package["scripts"]:
            if isinstance(label, str) and re.fullmatch(r"test(?::[A-Za-z0-9:_-]+)?", label):
                runners.append({"runner": manager, "label": label, "argv": [manager, "run", label]})
    if any((root / name).is_file() for name in ("pytest.ini", ".pytest.ini", "conftest.py")) or (root / "tests").is_dir():
        runners.append({"runner": "pytest", "argv": ["python", "-m", "pytest"]})
    if (root / "Cargo.toml").is_file():
        runners.append({"runner": "cargo", "argv": ["cargo", "test"]})
    if (root / "go.mod").is_file():
        runners.append({"runner": "go", "argv": ["go", "test", "./..."]})
    if any(p.suffix.lower() in (".sln", ".slnx", ".csproj", ".fsproj") for p in root.iterdir() if p.is_file()):
        runners.append({"runner": "dotnet", "argv": ["dotnet", "test"]})
    return runners


def project_status(data):
    root = selected_root(data)
    languages = {}
    files = 0
    skipped_external = 0
    truncated = False
    deadline = time.monotonic() + 5
    for directory, directories, filenames in os.walk(root, followlinks=False):
        safe_dirs = []
        for name in directories:
            if name in SKIP_DIRS:
                continue
            path = Path(directory) / name
            if not within(root, path.resolve()) or path.is_symlink():
                skipped_external += 1
                continue
            safe_dirs.append(name)
        directories[:] = safe_dirs
        for name in filenames:
            path = Path(directory) / name
            if not within(root, path.resolve()) or path.is_symlink():
                skipped_external += 1
                continue
            files += 1
            language = LANGUAGES.get(path.suffix.lower())
            if language:
                languages[language] = languages.get(language, 0) + 1
            if files >= 10_000 or time.monotonic() > deadline:
                truncated = True
                break
        if truncated:
            break
    return {"root": str(root), "file_count": files, "languages": languages, "truncated": truncated,
            "skipped_external_links": skipped_external, "git": git_repository(root), "test_runners": discover_tests(root),
            "test_execution": "Run the chosen argv through the approved command gateway."}


def tsserver_command():
    configured = os.environ.get("PC_LINK_TSSERVER")
    server = Path(configured) if configured else Path(__file__).resolve().parent / "node_modules" / "typescript" / "lib" / "tsserver.js"
    node = os.environ.get("PC_LINK_NODE") or shutil.which("node")
    if node and server.is_file():
        return [node, str(server), "--disableAutomaticTypingAcquisition", "--useInferredProjectPerProjectRoot"]
    return None


def language_status(data):
    selected_root(data)
    pylsp = importlib.util.find_spec("pylsp") is not None
    typescript = tsserver_command() is not None
    return {"python": {"available": pylsp, "server": "python-lsp-server", "transport": "LSP stdio"},
            "typescript": {"available": typescript, "server": "tsserver", "transport": "tsserver stdio"},
            "operations": ["lsp_symbols", "lsp_definition"],
            "positions": "line and character are zero-based; character uses UTF-16 code units."}


class StdioServer:
    def __init__(self, argv, mode="lsp"):
        self.mode = mode
        self.sequence = 0
        self.messages = queue.Queue(maxsize=500)
        self.closed = False
        self.proc = subprocess.Popen(argv, cwd=str(Path(__file__).resolve().parent), env=process_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=creation_flags())
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.err_reader = threading.Thread(target=self._drain_errors, daemon=True)
        self.err_reader.start()

    def _drain_errors(self):
        try:
            while self.proc.stderr.read(8192):
                pass
        except OSError:
            pass

    def _read(self):
        try:
            while not self.closed:
                length = None
                header_bytes = 0
                while True:
                    line = self.proc.stdout.readline(4097)
                    if not line:
                        return
                    header_bytes += len(line)
                    if header_bytes > 8192:
                        raise ValueError("Oversize RPC header")
                    if line in (b"\r\n", b"\n"):
                        if length is not None:
                            break
                        continue
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1].strip())
                if length is None or not 0 <= length <= MAX_RPC_MESSAGE:
                    raise ValueError("Invalid RPC length")
                raw = self.proc.stdout.read(length)
                if len(raw) != length:
                    return
                value = json.loads(raw.decode("utf-8"))
                self.messages.put(value, timeout=1)
        except (OSError, ValueError, queue.Full):
            return

    def send(self, value):
        raw = output_json(value).encode("utf-8")
        if self.mode == "tsserver":
            payload = raw + b"\n"
        else:
            payload = b"Content-Length: " + str(len(raw)).encode("ascii") + b"\r\n\r\n" + raw
        try:
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()
        except (OSError, BrokenPipeError):
            raise ProjectError("language_server_failed", "The language server closed its input.") from None

    def notify(self, method, params):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method, params, timeout=20):
        self.sequence += 1
        sequence = self.sequence
        if self.mode == "tsserver":
            self.send({"seq": sequence, "type": "request", "command": method, "arguments": params})
        else:
            self.send({"jsonrpc": "2.0", "id": sequence, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=min(0.25, max(0, deadline - time.monotonic())))
            except queue.Empty:
                if self.proc.poll() is not None:
                    raise ProjectError("language_server_failed", "The language server stopped before returning a result.")
                continue
            if self.mode == "tsserver":
                if message.get("type") == "response" and message.get("request_seq") == sequence:
                    if not message.get("success"):
                        raise ProjectError("language_query_failed", "The language server could not resolve this query.")
                    return message.get("body")
            elif message.get("id") == sequence and "method" not in message:
                if "error" in message:
                    raise ProjectError("language_query_failed", "The language server could not resolve this query.")
                return message.get("result")
            elif "method" in message and "id" in message:
                # Never approve an edit requested by a language server.
                method = message["method"]
                result = {"applied": False} if method == "workspace/applyEdit" else [] if method == "workspace/configuration" else None
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})
        raise ProjectError("language_server_timeout", "The language query exceeded its time limit.")

    def close(self):
        self.closed = True
        terminate_tree(self.proc)
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass
        self.reader.join(timeout=1)
        self.err_reader.join(timeout=1)


def read_document(root, data):
    path = selected_path(root, data.get("path"))
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ProjectError("file_too_large", "Language queries support files up to 1 MiB.")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        raise ProjectError("invalid_encoding", "Language queries require a UTF-8 source file.") from None
    language = LANGUAGES.get(path.suffix.lower())
    if language not in ("python", "typescript", "typescriptreact", "javascript", "javascriptreact"):
        raise ProjectError("language_unsupported", "Language queries currently support Python, TypeScript, and JavaScript.")
    return path, text, language


def initialize_python(server, root, path, text):
    server.request("initialize", {"processId": os.getpid(), "rootUri": root.as_uri(), "workspaceFolders": [{"uri": root.as_uri(), "name": root.name}], "capabilities": {"workspace": {"configuration": False}, "textDocument": {"documentSymbol": {"hierarchicalDocumentSymbolSupport": True}, "definition": {"linkSupport": True}}}})
    server.notify("initialized", {})
    plugins = {name: {"enabled": False} for name in ("pycodestyle", "pyflakes", "flake8", "pylint", "mccabe", "autopep8", "yapf", "black", "ruff", "rope_autoimport", "rope_completion", "jedi_completion", "jedi_hover", "jedi_references")}
    plugins.update(jedi_symbols={"enabled": True}, jedi_definition={"enabled": True, "follow_imports": True})
    server.notify("workspace/didChangeConfiguration", {"settings": {"pylsp": {"plugins": plugins}}})
    server.notify("textDocument/didOpen", {"textDocument": {"uri": path.as_uri(), "languageId": "python", "version": 1, "text": text}})


def bounded_symbols(values, maximum):
    count = 0
    def walk(items, depth=0):
        nonlocal count
        output = []
        if not isinstance(items, list) or depth > 8:
            return output
        for item in items:
            if count >= maximum:
                break
            if not isinstance(item, dict):
                continue
            count += 1
            symbol = {key: item[key] for key in ("name", "detail", "kind", "range", "selectionRange", "location", "containerName") if key in item}
            for key in ("name", "detail", "containerName"):
                if isinstance(symbol.get(key), str):
                    symbol[key] = symbol[key][:1000]
            if item.get("children"):
                symbol["children"] = walk(item["children"], depth + 1)
            output.append(symbol)
        return output
    result = walk(values)
    return result, count >= maximum


def uri_path(value):
    parsed = urlparse(value)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        return None
    raw = unquote(parsed.path)
    if os.name == "nt" and re.match(r"^/[A-Za-z]:", raw):
        raw = raw[1:]
    return Path(raw).resolve()


def normalize_definitions(root, result, mode):
    if result is None:
        return [], 0
    if not isinstance(result, list):
        result = [result]
    output = []
    outside = 0
    for entry in result[:200]:
        if not isinstance(entry, dict):
            continue
        if mode == "tsserver":
            path = Path(entry.get("file", "")).resolve()
            start, end = entry.get("start", {}), entry.get("end", {})
            location = {"path": str(path), "range": {"start": {"line": max(0, start.get("line", 1) - 1), "character": max(0, start.get("offset", 1) - 1)}, "end": {"line": max(0, end.get("line", 1) - 1), "character": max(0, end.get("offset", 1) - 1)}}}
        else:
            path = uri_path(entry.get("targetUri", entry.get("uri", "")))
            if path is None:
                continue
            location = {"path": str(path), "range": entry.get("targetSelectionRange", entry.get("range"))}
        if not within(root, path):
            outside += 1
            continue
        output.append(location)
    return output, outside


def ts_symbols(tree, maximum):
    count = 0
    def walk(item, depth=0):
        nonlocal count
        if not isinstance(item, dict) or count >= maximum or depth > 8:
            return None
        count += 1
        spans = item.get("spans", [])
        symbol = {"name": str(item.get("text", ""))[:1000], "kind": item.get("kind"), "spans": spans[:10]}
        children = [walk(child, depth + 1) for child in item.get("childItems", [])]
        children = [child for child in children if child is not None]
        if children:
            symbol["children"] = children
        return symbol
    value = walk(tree)
    return ([] if value is None else [value]), count >= maximum


def language_query(data, action):
    root = selected_root(data)
    path, text, language = read_document(root, data)
    maximum = integer(data, "limit", 300, 1, 1000)
    server = None
    try:
        if language == "python":
            if importlib.util.find_spec("pylsp") is None:
                raise ProjectError("tool_unavailable", "python-lsp-server is not installed in the agent runtime.")
            server = StdioServer([sys.executable, "-I", "-m", "pylsp"])
            initialize_python(server, root, path, text)
            if action == "lsp_symbols":
                result = server.request("textDocument/documentSymbol", {"textDocument": {"uri": path.as_uri()}})
                symbols, truncated = bounded_symbols(result or [], maximum)
                return {"path": str(path), "language": language, "symbols": symbols, "truncated": truncated}
            line, character = integer(data, "line", 0), integer(data, "character", 0)
            result = server.request("textDocument/definition", {"textDocument": {"uri": path.as_uri()}, "position": {"line": line, "character": character}})
            locations, outside = normalize_definitions(root, result, "lsp")
        else:
            command = tsserver_command()
            if command is None:
                raise ProjectError("tool_unavailable", "TypeScript tsserver is not installed or configured in the agent runtime.")
            server = StdioServer(command, mode="tsserver")
            server.request("configure", {"preferences": {"includePackageJsonAutoImports": "off"}, "hostInfo": "PC Link"})
            server.request("open", {"file": str(path), "fileContent": text, "projectRootPath": str(root)})
            if action == "lsp_symbols":
                result = server.request("navtree", {"file": str(path)})
                symbols, truncated = ts_symbols(result, maximum)
                return {"path": str(path), "language": language, "symbols": symbols, "truncated": truncated}
            line, character = integer(data, "line", 0), integer(data, "character", 0)
            result = server.request("definition", {"file": str(path), "line": line + 1, "offset": character + 1})
            locations, outside = normalize_definitions(root, result, "tsserver")
        return {"path": str(path), "language": language, "definitions": locations, "outside_project_results_omitted": outside}
    finally:
        if server is not None:
            server.close()


ACTIONS = ("project_status", "git_diff", "language_status", "lsp_symbols", "lsp_definition")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=ACTIONS)
    options = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ProjectError("input_too_large", "Project query input exceeds 2 MiB.")
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise ProjectError("invalid_json", "Input must be a UTF-8 JSON object.") from None
        if not isinstance(data, dict):
            raise ProjectError("invalid_argument", "Input must be a JSON object.")
        if options.action in ("lsp_symbols", "lsp_definition"):
            result = language_query(data, options.action)
        else:
            result = globals()[options.action](data)
        output, exit_code = {"ok": True, **result}, 0
    except ProjectError as exc:
        output, exit_code = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}, 1
    except (OSError, ValueError, TypeError, OverflowError, subprocess.SubprocessError):
        output, exit_code = {"ok": False, "error": {"code": "project_query_failed", "message": "The local project query could not be completed."}}, 1
    sys.stdout.buffer.write((output_json(output) + "\n").encode("utf-8"))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
