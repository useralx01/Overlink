from __future__ import annotations
import argparse
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys
import tempfile
import time

EXTENSIONS = frozenset((".py",".js",".mjs",".cjs",".ts",".tsx",".jsx",".cs",".java",".go",".rs",".json",".sql",".css",".html",".md",".ps1",".sh",".yaml",".yml"))
IGNORED = frozenset((".git","node_modules",".venv","__pycache__","dist","build",".next","target",".overlink-backups",".idea",".vscode"))
PRIVATE = frozenset((".env","device.bin","runtime.json","credentials.json","id_rsa","id_ed25519"))
PATTERN = re.compile(r"(?:ghp_[a-zA-Z0-9]{20,}|sk-(?:proj-)?[a-zA-Z0-9_-]{15,}|(?i:password|token|api_key|secret)\s*[:=]\s*['\"]?[^\s,'\"]{5,})")

class IndexErrorSafe(Exception):
    pass

def project_root(data):
    value=data.get("root")
    if not isinstance(value,str) or not value or "\0" in value or len(value)>4096:
        raise IndexErrorSafe("Missing or invalid project root")
    folder=pathlib.Path(value).resolve(strict=True)
    if not folder.is_dir():
        raise IndexErrorSafe("Project root is not a directory")
    return folder

def cache_file(root):
    name=hashlib.sha256(str(root).casefold().encode("utf-8")).hexdigest()
    base=os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_CACHE_HOME")
    if not base:
        base=pathlib.Path(tempfile.gettempdir())/"vyrmesh-index-user"
    folder=pathlib.Path(base)/"Overlink"/"indexes"
    folder.mkdir(parents=True, exist_ok=True)
    return folder/(name+".sqlite")

def connection(root):
    db=sqlite3.connect(cache_file(root),timeout=3)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime_ns INTEGER, sha256 TEXT NOT NULL)")
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fragments USING fts5(path UNINDEXED, line UNINDEXED, content, tokenize='unicode61')")
    return db

def files_in(root):
    count=0
    for directory, dirs, files in os.walk(root,followlinks=False):
        dirs[:]=sorted(d for d in dirs if d not in IGNORED and not (pathlib.Path(directory)/d).is_symlink())
        for filename in sorted(files):
            target=pathlib.Path(directory)/filename
            suffix=target.suffix.lower()
            if filename.lower() in PRIVATE or filename.lower().startswith(".env.") or suffix not in EXTENSIONS or target.is_symlink():
                continue
            if any(part in IGNORED for part in target.relative_to(root).parts):
                continue
            try:
                st=target.stat()
            except OSError:
                continue
            if st.st_size>200_000:continue
            yield target,st
            count+=1
            if count>=1000:
                return

def redact(text):
    return PATTERN.sub("[redacted]",text)

def index(root):
    began=time.perf_counter()
    seen=set(); updated=0; unchanged=0; fragments=0
    db=connection(root)
    try:
        for file,st in files_in(root):
            rel=file.relative_to(root).as_posix()
            seen.add(rel)
            previous=db.execute("SELECT size,mtime_ns FROM files WHERE path=?",(rel,)).fetchone()
            if previous==(st.st_size,st.st_mtime_ns):
                unchanged+=1
                continue
            try:
                raw=file.read_bytes()
                source=raw.decode("utf-8")
            except (UnicodeError,OSError):
                continue
            lines=source.splitlines()
            sha=hashlib.sha256(raw).hexdigest()
            db.execute("DELETE FROM fragments WHERE path=?",(rel,))
            for start in range(0,len(lines),14):
                content=redact("\n".join(lines[start:start+17]))[:2800]
                if content.strip():
                    db.execute("INSERT INTO fragments(path,line,content) VALUES(?,?,?)",(rel,start+1,content))
                    fragments+=1
            db.execute("INSERT OR REPLACE INTO files(path,size,mtime_ns,sha256) VALUES (?,?,?,?)",
                       (rel,st.st_size,st.st_mtime_ns,sha))
            updated+=1
        previous_paths=[row[0] for row in db.execute("SELECT path FROM files")]
        for rel in previous_paths:
            if rel not in seen:
                db.execute("DELETE FROM fragments WHERE path=?",(rel,))
                db.execute("DELETE FROM files WHERE path=?",(rel,))
        db.commit()
        count=db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        return {"ok":True,"indexed_files":count,"updated":updated,"unchanged":unchanged,
                "new_fragments":fragments,"elapsed_ms":round((time.perf_counter()-began)*1000,2)}
    finally:
        db.close()

def search(root,data):
    query=data.get("query")
    if not isinstance(query,str) or len(query)>300:
        raise IndexErrorSafe("Search query must be shorter than 300 characters")
    tokens=re.findall(r"[A-Za-z0-9_]{2,}",query)[:8]
    if not tokens:
        raise IndexErrorSafe("Search query needs an alphanumeric keyword")
    fts=" OR ".join('"'+token+'"' for token in tokens)
    limit=data.get("limit",12)
    if not isinstance(limit,int) or isinstance(limit,bool) or not 1<=limit<=25:
        raise IndexErrorSafe("Invalid search result limit")
    db=connection(root)
    try:
        rows=db.execute("SELECT path,line,snippet(fragments,2,'','',' … ',15) AS hit,bm25(fragments) AS score FROM fragments WHERE fragments MATCH ? ORDER BY score LIMIT ?",
                        (fts,limit)).fetchall()
        hits=[{"path":row[0],"line":int(row[1]),"excerpt":redact(row[2])[:700],
               "rank":round(float(row[3]),4)} for row in rows]
        return {"ok":True,"matches":hits,"query_tokens":len(tokens),"indexed_files":db.execute("SELECT COUNT(*) FROM files").fetchone()[0]}
    finally:
        db.close()

def status(root):
    db=connection(root)
    try:
        return {"ok":True,"indexed_files":db.execute("SELECT COUNT(*) FROM files").fetchone()[0],
                "fragments":db.execute("SELECT COUNT(*) FROM fragments").fetchone()[0],
                "cache_bytes":cache_file(root).stat().st_size}
    finally:db.close()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("action",choices=("index","search","status","context"))
    action=parser.parse_args().action
    try:
        raw=sys.stdin.buffer.read(100_001)
        if len(raw)>100_000:
            raise IndexErrorSafe("Index request too large")
        data=json.loads(raw.decode("utf-8"))
        root=project_root(data)
        if action=="index":result=index(root)
        elif action=="status":result=status(root)
        else:
            if data.get("update_first") is True:index(root)
            result=search(root,data)
            if action=="context":
                result["context"]=[{"file":m["path"],"start_line":m["line"],"text":m["excerpt"]} for m in result.pop("matches")]
        print(json.dumps(result,ensure_ascii=False))
        return 0
    except (IndexErrorSafe,OSError,sqlite3.Error,ValueError,TypeError,UnicodeError) as exc:
        print(json.dumps({"ok":False,"error":{"code":"index_failed","message":str(exc)[:200]}}))
        return 1

if __name__=="__main__":
    raise SystemExit(main())
