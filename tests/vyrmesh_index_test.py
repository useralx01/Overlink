from __future__ import annotations
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

MODULE=pathlib.Path(__file__).resolve().parents[1]/"agent"/"vyrmesh_index.py"
spec=importlib.util.spec_from_file_location("vyrmesh_index",MODULE)
indexer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(indexer)

class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)/"project"
        self.root.mkdir()
        self.cache=pathlib.Path(self.temp.name)/"cache"
        self.original=os.environ.get("XDG_CACHE_HOME"),os.environ.get("LOCALAPPDATA")
        os.environ.pop("LOCALAPPDATA",None)
        os.environ["XDG_CACHE_HOME"]=str(self.cache)
        self.addCleanup(self.restore)
        (self.root/"alpha.py").write_text("def cosmic_connector():\n  return 42\n",encoding="utf-8")
        (self.root/"beta.ts").write_text("function starship() { return 'launch'; }\n",encoding="utf-8")
    def restore(self):
        for key,value in zip(("XDG_CACHE_HOME","LOCALAPPDATA"),self.original):
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value
    def test_incremental_index_and_fts_search(self):
        result=indexer.index(self.root)
        self.assertEqual(result["indexed_files"],2)
        self.assertEqual(result["updated"],2)
        again=indexer.index(self.root)
        self.assertEqual(again["updated"],0)
        self.assertEqual(again["unchanged"],2)
        hits=indexer.search(self.root,{"query":"cosmic connector"})
        self.assertEqual(hits["matches"][0]["path"],"alpha.py")
    def test_changed_file_refresh_and_delete(self):
        indexer.index(self.root)
        (self.root/"alpha.py").write_text("def galactic_newthing(): return 1\n",encoding="utf-8")
        refresh=indexer.index(self.root)
        self.assertEqual(refresh["updated"],1)
        self.assertTrue(indexer.search(self.root,{"query":"galactic"})["matches"])
        (self.root/"beta.ts").unlink()
        self.assertEqual(indexer.index(self.root)["indexed_files"],1)
    def test_secret_filename_excluded(self):
        (self.root/".env").write_text("password=verysecret",encoding="utf-8")
        (self.root/"config.pem").write_text("PRIVATE KEY",encoding="utf-8")
        self.assertEqual(indexer.index(self.root)["indexed_files"],2)
        self.assertEqual(indexer.search(self.root,{"query":"verysecret"})["matches"],[])
    def test_search_snippet_redacts_token(self):
        (self.root/"gamma.js").write_text("const warning = 'TOKEN=somepasswordvalue cosmic';",encoding="utf-8")
        indexer.index(self.root)
        hits=indexer.search(self.root,{"query":"cosmic"})["matches"]
        for hit in hits:
            self.assertNotIn("somepasswordvalue",hit["excerpt"])
    def test_query_validation(self):
        with self.assertRaises(indexer.IndexErrorSafe):
            indexer.search(self.root,{"query":"???"})
    def test_index_metadata_no_absolute_paths(self):
        indexer.index(self.root)
        r=indexer.search(self.root,{"query":"starship"})
        self.assertEqual(r["matches"][0]["path"],"beta.ts")
        self.assertNotIn(str(self.root),json.dumps(r))
    def test_ignores_node_modules(self):
        (self.root/"node_modules").mkdir()
        (self.root/"node_modules"/"evil.js").write_text("function injected(){}",encoding="utf-8")
        self.assertEqual(indexer.index(self.root)["indexed_files"],2)
        self.assertEqual(indexer.search(self.root,{"query":"injected"})["matches"],[])
    def test_status_uses_persistent_cache(self):
        indexer.index(self.root)
        state=indexer.status(self.root)
        self.assertEqual(state["indexed_files"],2)
        self.assertGreater(state["fragments"],0)

if __name__=="__main__":
    unittest.main()
