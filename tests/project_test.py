import json, os, subprocess, sys, tempfile, unittest, shutil
from pathlib import Path
AGENT=Path(__file__).resolve().parents[1]/'agent'
class ProjectTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  (self.root/'fixture.py').write_text('def greeting(name):\n    return "hello " + name\n\nmessage = greeting("PC Link")\n')
  (self.root/'fixture.ts').write_text('function greeting(name: string): string { return "hello " + name; }\nconst message = greeting("PC Link");\n')
 def tearDown(self):self.temp.cleanup()
 def query(self,action,**args):
  env=dict(os.environ,PC_LINK_NODE=shutil.which('node') or 'node',PC_LINK_GIT=shutil.which('git') or 'git')
  r=subprocess.run([sys.executable,'-I',str(AGENT/'project_inspect.py'),action],input=json.dumps({'root':str(self.root),**args}),text=True,capture_output=True,env=env,timeout=45)
  return json.loads(r.stdout)
 def test_discovery_without_executing_repo(self):
  r=self.query('project_status');self.assertTrue(r['ok']);self.assertEqual(r['file_count'],2);self.assertIn('python',r['languages'])
 def test_path_escape_rejected(self):
  r=self.query('lsp_symbols',path='../outside.py');self.assertFalse(r['ok'])
 def test_language_servers_and_real_queries(self):
  r=self.query('language_status');self.assertTrue(r['python']['available']);self.assertTrue(r['typescript']['available'])
  for path in ['fixture.py','fixture.ts']:
   r=self.query('lsp_symbols',path=path);self.assertTrue(r['ok'],r);self.assertIn('greeting',str(r['symbols']))
  r=self.query('lsp_definition',path='fixture.py',line=3,character=11);self.assertTrue(r['ok'],r);self.assertTrue(r['definitions'])
 def test_git_status_and_confined_diff(self):
  git=shutil.which('git') or 'git'
  subprocess.run([git,'init',str(self.root)],capture_output=True,check=True)
  r=self.query('project_status');self.assertTrue(r['ok']);self.assertIn('fixture.py',str(r['git']))
  r=self.query('git_diff');self.assertTrue(r['ok'])
if __name__=='__main__':unittest.main(verbosity=2)
