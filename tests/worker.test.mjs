import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const OWNER = 'owner@example.invalid', DEVICE = 'device-test', SECRET = 'test-device-key';
const sha = value => createHash('sha256').update(value).digest('hex');
const ownerHeaders = { 'oai-authenticated-user-id': 'owner-user', 'oai-authenticated-user-email': OWNER };
// A decodable 1×1 PNG, rather than only a four-byte JPEG signature.
const screenshotData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmFcAAAAASUVORK5CYII=';
const screenshotResult = () => ({ ok:true, screenshot_id:'test-capture', image:{data:screenshotData,mimeType:'image/png',width:1,height:1} });
const imageJob = async fixture => (await (await fixture.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_job',arguments:{job_id:'job-test'}}},ownerHeaders)).json()).result;

function setup({ deviceOwner = OWNER, revoked = 0 } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE devices(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,key_hash TEXT NOT NULL,root TEXT NOT NULL,terminal INTEGER NOT NULL,last_seen INTEGER NOT NULL,created INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,capabilities TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE jobs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,owner TEXT NOT NULL,operation TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,completed INTEGER,approved INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE once(name TEXT PRIMARY KEY,used INTEGER NOT NULL);`);
  sqlite.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,?,?)').run(DEVICE, deviceOwner, 'Test PC', sha(SECRET), 'C:\\Shared', 1, Date.now(), Date.now(), revoked, JSON.stringify({version:2,fileWrite:true,desktopView:true,desktopInput:true,browserControl:true,browserDebug:false,projectTools:true,memory:true,audit:true,externalDevices:false}));
  const fixture = { sqlite, hook: null, images:new Map() };
  fixture.env = {
    PC_LINK_OWNER_EMAIL: OWNER,
    PC_LINK_TRANSPORT_TOKEN: 'dummy-test-transport-token',
    IMAGES:{ async put(key,value){fixture.images.set(key,new Uint8Array(value))},async get(key){const bytes=fixture.images.get(key);return bytes?{arrayBuffer:async()=>bytes.buffer}:null},async delete(key){fixture.images.delete(key)} },
    DB: {
      prepare(sql) {
        let values = [];
        const statement = {
          bind(...args) { values = args; return statement; },
          async first() {
            const row = sqlite.prepare(sql).get(...values) ?? null;
            if (fixture.hook) await fixture.hook(sql, row);
            return row;
          },
          async all() { return { results: sqlite.prepare(sql).all(...values) }; },
          async run() {
            const result = sqlite.prepare(sql).run(...values);
            if (fixture.afterRun) await fixture.afterRun(sql, result);
            return { success: true, meta: { changes: Number(result.changes) } };
          }
        };
        return statement;
      },
      async batch(statements) { return Promise.all(statements.map(s => s.run())); }
    }
  };
  fixture.job = (id = 'job-test', { age = 0, state = 'queued', owner = OWNER, device = DEVICE } = {}) => {
    sqlite.prepare('INSERT INTO jobs(id,device_id,owner,operation,args,state,created) VALUES(?,?,?,?,?,?,?)').run(id, device, owner, 'write', JSON.stringify({path:'example.txt',content:'hello'}), state, Date.now() - age);
    return id;
  };
  fixture.call = (path, data, headers = {}) => worker.fetch(new Request(`https://pc-link.example.invalid${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(path.startsWith('/api/') && data !== undefined ? { origin: 'https://pc-link.example.invalid' } : {}), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data)
  }), fixture.env);
  fixture.poll = () => fixture.call('/device/poll', {id:DEVICE, root:'C:\\Shared', terminal:true}, {'x-pc-link-device-key':SECRET});
  return fixture;
}

test('MCP discovery requires trusted owner identity', async () => {
  const f = setup();
  for (const headers of [{}, {'oai-authenticated-user-email':OWNER}, {...ownerHeaders,'oai-authenticated-user-email':'other@example.invalid'}]) {
    assert.equal((await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},headers)).status,403);
  }
  const response = await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},ownerHeaders);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).result.tools.slice(0,6).map(t => t.name),['list_computers','list_files','read_file','write_file','run_command','get_job']);
});

test('transport credential does not manufacture browser or MCP identity', async () => {
  const f = setup(), headers = {'OAI-Sites-Authorization':'Bearer dummy-test-transport-token'};
  assert.equal((await f.call('/api/devices',undefined,headers)).status,403);
  assert.equal((await f.call('/api/pair',{name:'Bad PC'},headers)).status,403);
  assert.equal((await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},headers)).status,403);
});

test('native polling requires device key, matching owner, and nonrevoked device', async () => {
  const f = setup();
  assert.equal((await f.call('/device/poll',{id:DEVICE})).status,401);
  assert.equal((await f.call('/device/poll',{id:DEVICE},{'x-pc-link-device-key':'wrong'})).status,403);
  assert.equal((await setup({deviceOwner:'other@example.invalid'}).poll()).status,403);
  assert.equal((await setup({revoked:1}).poll()).status,403);
});

test('job claim is at most once, including concurrent polling', async () => {
  const f = setup(); f.job();
  const responses = await Promise.all([f.poll(),f.poll()]);
  const jobs = (await Promise.all(responses.map(r => r.json()))).map(r => r.job).filter(Boolean);
  assert.equal(jobs.length,1);
  assert.equal(jobs[0].id,'job-test');
  assert.equal((await (await f.poll()).json()).job,null);
  assert.equal(f.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get('job-test').state,'running');
});

test('stale queued operations are never claimed or automatically replayed', async () => {
  const f = setup(); f.job('old-job',{age:301000}); f.job('running-job',{state:'running'});
  assert.equal((await (await f.poll()).json()).job,null);
});

test('only claimed jobs on the authenticated device accept results', async () => {
  const f = setup(); f.job(); f.job('other-job',{state:'running',device:'other-device'});
  const submit = id => f.call('/device/result',{id:DEVICE,job_id:id,result:{ok:true}},{'x-pc-link-device-key':SECRET});
  assert.equal((await submit('job-test')).status,409);
  assert.equal((await submit('other-job')).status,409);
  await f.poll();
  assert.equal((await submit('job-test')).status,200);
  assert.equal((await submit('job-test')).status,409);
});

test('revoked devices cannot submit even a previously claimed job result', async () => {
  const f = setup(); f.job(); await f.poll();
  await f.call('/api/revoke',{id:DEVICE},ownerHeaders);
  assert.equal((await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:{ok:true}},{'x-pc-link-device-key':SECRET})).status,403);
});

test('get_job cannot read another owner job', async () => {
  const f = setup(); f.job('foreign-job',{owner:'other@example.invalid',state:'done'});
  const response = await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_job',arguments:{job_id:'foreign-job'}}},ownerHeaders);
  const body = await response.json();
  assert.equal(body.result.isError,true);
  assert.match(body.result.content[0].text,/not found/i);
});

test('RSA pairing yields a decryptable sealed config and stores only device key hash', async () => {
  const f = setup();
  const pair = await webcrypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:4096,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-1'},true,['encrypt','decrypt']);
  const publicKey = await webcrypto.subtle.exportKey('jwk',pair.publicKey);
  const response = await f.call('/api/pair',{name:'New PC',root:'C:\\Pair',terminal:false,publicKey},ownerHeaders);
  assert.equal(response.status,200);
  const sealed = (await response.json()).sealed;
  const config = JSON.parse(Buffer.from(await webcrypto.subtle.decrypt({name:'RSA-OAEP'},pair.privateKey,Buffer.from(sealed,'base64'))).toString('utf8'));
  assert.equal(config.transport,'dummy-test-transport-token');
  const row = f.sqlite.prepare('SELECT * FROM devices WHERE id=?').get(config.id);
  assert.equal(row.owner,OWNER); assert.equal(row.key_hash,sha(config.key));
  assert.equal(row.name,'New PC'); assert.equal(row.terminal,0);
  assert.equal(JSON.stringify(row).includes(config.key),false);
});

test('oversized RSA config rejects before inserting a device', async () => {
  const f = setup(); f.env.PC_LINK_TRANSPORT_TOKEN = 'T'.repeat(600);
  const pair = await webcrypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:4096,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-1'},true,['encrypt','decrypt']);
  const publicKey = await webcrypto.subtle.exportKey('jwk',pair.publicKey);
  const response = await f.call('/api/pair',{name:'New PC',root:'C:\\Pair',publicKey},ownerHeaders);
  assert.equal(response.status,400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get().n,1);
});

test('browser mutation rejects a cross-origin request even with forwarded identity', async () => {
  const f = setup();
  const response = await f.call('/api/revoke',{id:DEVICE},{...ownerHeaders,origin:'https://untrusted.example.invalid','content-type':'text/plain'});
  assert.equal(response.status,403);
  assert.equal(f.sqlite.prepare('SELECT revoked FROM devices WHERE id=?').get(DEVICE).revoked,0);
});

test('revocation between device authorization and claim prevents execution', async () => {
  const f = setup(); f.job();
  let injected = false;
  f.hook = async sql => {
    if (!injected && sql.startsWith('SELECT * FROM devices WHERE id=? AND revoked=0')) {
      injected = true;
      f.sqlite.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(DEVICE);
    }
  };
  const response = await f.poll();
  assert.equal((await response.json()).job,null);
  assert.equal(f.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get('job-test').state,'queued');
});

test('revocation between device authorization and result submission prevents update', async () => {
  const f = setup(); f.job('job-test',{state:'running'});
  let injected = false;
  f.hook = async sql => {
    if (!injected && sql.startsWith('SELECT * FROM devices WHERE id=? AND revoked=0')) {
      injected = true;
      f.sqlite.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(DEVICE);
    }
  };
  const response = await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:{ok:true}},{'x-pc-link-device-key':SECRET});
  assert.ok(response.status >= 400);
  assert.equal(f.sqlite.prepare('SELECT state FROM jobs WHERE id=?').get('job-test').state,'running');
});

function immediateCompletion(f) {
  f.afterRun = async sql => {
    if (/^INSERT(?: OR IGNORE)? INTO jobs/.test(sql)) {
      f.sqlite.prepare("UPDATE jobs SET state='done',result=?,completed=? WHERE state='queued'").run(JSON.stringify({ok:true}),Date.now());
    }
  };
  return async (name,args) => (await (await f.call('/mcp',{
    jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}
  },ownerHeaders)).json()).result;
}

test('write and command schemas require a stable request ID for retries', async () => {
  const f = setup();
  const response = await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},ownerHeaders);
  const tools = (await response.json()).result.tools;
  for (const name of ['write_file','run_command']) {
    const tool = tools.find(t => t.name === name);
    assert.equal(tool.inputSchema.properties.request_id.type,'string');
    assert.ok(tool.inputSchema.required.includes('request_id'));
  }
});

test('a duplicate write request returns the original job and never inserts another', async () => {
  const f = setup(), call = immediateCompletion(f);
  const args = {computer_id:DEVICE,path:'hello.txt',content:'hello',request_id:'write-request-1'};
  const first = await call('write_file',args), second = await call('write_file',args);
  assert.equal(first.isError,undefined); assert.equal(second.isError,undefined);
  assert.equal(first.structuredContent.job_id,second.structuredContent.job_id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
});

test('simultaneous duplicate command requests produce exactly one durable job', async () => {
  const f = setup(), call = immediateCompletion(f);
  const args = {computer_id:DEVICE,command:'Write-Output hello',request_id:'command-request-1'};
  const responses = await Promise.all([call('run_command',args),call('run_command',args)]);
  assert.ok(responses.every(r => !r.isError));
  assert.equal(responses[0].structuredContent.job_id,responses[1].structuredContent.job_id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
});

test('reusing a request ID with changed content rejects instead of executing', async () => {
  const f = setup(), call = immediateCompletion(f);
  const args = {computer_id:DEVICE,path:'hello.txt',content:'hello',request_id:'request-with-fixed-content'};
  await call('write_file',args);
  const changed = await call('write_file',{...args,content:'different'});
  assert.equal(changed.isError,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
});

test('a request ID cannot be reused for a different operation', async () => {
  const f = setup(), call = immediateCompletion(f), request_id = 'one-operation-only';
  await call('write_file',{computer_id:DEVICE,path:'hello.txt',content:'hello',request_id});
  const changed = await call('run_command',{computer_id:DEVICE,command:'Write-Output hello',request_id});
  assert.equal(changed.isError,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
});

test('different request IDs permit deliberately repeated commands', async () => {
  const f = setup(), call = immediateCompletion(f), args = {computer_id:DEVICE,command:'Write-Output hello'};
  const first = await call('run_command',{...args,request_id:'distinct-request-1'});
  const second = await call('run_command',{...args,request_id:'distinct-request-2'});
  assert.ok(!first.isError && !second.isError);
  assert.notEqual(first.structuredContent.job_id,second.structuredContent.job_id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,2);
});

test('v2 tools advertise computer agent operations and capability metadata',async()=>{
 const f=setup();const r=await (await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},ownerHeaders)).json();
 for(const name of ['pc_status','screenshot','windows','ui_inspect','ui_action','desktop_input','browser','project','memory','audit','task_history','devices'])assert.ok(r.result.tools.some(t=>t.name===name));
 assert.equal((await (await f.call('/api/devices',undefined,ownerHeaders)).json()).computers[0].capabilities.version,2);
 const call=immediateCompletion(f);const response=await call('browser',{device_id:DEVICE,action:'click',args:{sessionId:'s',pageId:'p'}});
 assert.equal(response.isError,true);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,0);
});
test('permission flags cannot be injected into browser arguments and disabled caps reject work',async()=>{
 const f=setup(),call=immediateCompletion(f);
 assert.equal((await call('browser',{device_id:DEVICE,action:'evaluate',request_id:'debug-1',args:{allowJavaScript:true,expression:'1'}})).isError,true);
 assert.equal((await call('browser',{device_id:DEVICE,action:'evaluate',request_id:'debug-2',args:{expression:'1'}})).isError,true);
 f.sqlite.prepare('UPDATE devices SET capabilities=?').run(JSON.stringify({version:2,desktopView:false}));
 assert.equal((await call('screenshot',{device_id:DEVICE})).isError,true);
});
test('heartbeat keeps long jobs online without claiming a second job',async()=>{
 const f=setup();f.job();await f.call('/device/heartbeat',{id:DEVICE,capabilities:{version:2,desktopView:true}},{'x-pc-link-device-key':SECRET});
 assert.equal(f.sqlite.prepare('SELECT state FROM jobs').get().state,'queued');
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT capabilities FROM devices').get().capabilities).desktopView,true);
});
test('approval requires a human endpoint and authorizes exactly one queued task',async()=>{
 const f=setup();f.job();await f.poll();
 await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:{ok:false,approval_required:true,summary:'write a test file'}},{'x-pc-link-device-key':SECRET});
 assert.equal((await (await f.poll()).json()).job,null);
 const m=await (await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_job',arguments:{job_id:'job-test'}}},ownerHeaders)).json();assert.equal(m.result.structuredContent.status,'approval');
 assert.equal((await f.call('/api/approve',{job_id:'job-test',approve:true},{...ownerHeaders,origin:'https://evil.invalid'})).status,403);
 assert.equal((await f.call('/api/approve',{job_id:'job-test',approve:true},ownerHeaders)).status,200);
 assert.equal((await (await f.poll()).json()).job.approved,true);
 assert.equal((await f.call('/api/approve',{job_id:'job-test',approve:true},ownerHeaders)).status,409);
 assert.equal((await (await f.poll()).json()).job,null);
});
test('local device approvals stay scoped and denied actions never run',async()=>{
 const f=setup();f.job('local',{state:'approval'});f.job('other',{state:'approval',device:'other-device'});
 const hdr={'x-pc-link-device-key':SECRET};
 assert.equal((await f.call('/device/approve',{id:DEVICE,job_id:'other',approve:true},hdr)).status,409);
 assert.equal((await f.call('/device/approve',{id:DEVICE,job_id:'local',approve:false},hdr)).status,200);
 assert.equal((await (await f.poll()).json()).job,null);
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT result FROM jobs WHERE id=?').get('local').result).denied,true);
});
test('screenshots use R2 and return an authenticated MCP image block without D1 base64',async()=>{
 const f=setup();f.job();await f.poll();
 assert.equal((await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:screenshotResult()},{'x-pc-link-device-key':SECRET})).status,200);
 const stored=JSON.parse(f.sqlite.prepare('SELECT result FROM jobs').get().result);assert.equal(stored.image.data,undefined);assert.equal(f.images.size,1);
 const result=await imageJob(f);
 assert.equal(result.content[1].type,'image');assert.equal(result.content[1].data,screenshotData);assert.equal(result.content[1].mimeType,'image/png');assert.equal(result.structuredContent.result.screenshot_id,'test-capture');
 assert.equal((await f.call('/api/image/job-test')).status,403);
 const download=await f.call('/api/image/job-test',undefined,ownerHeaders);assert.equal(download.status,200);
 assert.equal(download.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(screenshotData,'base64'));
});

test('overlapping screenshot upload retries preserve the winning R2 image',async()=>{
 const f=setup();f.job();await f.poll();
 // Both requests pass the running-job check. Pause the first R2 put until the
 // second has stored its bytes, forcing the competing D1 completion updates.
 let puts=0,releaseFirst;
 const secondPut=new Promise(resolve=>{releaseFirst=resolve});
 f.env.IMAGES.put=async(key,bytes)=>{f.images.set(key,new Uint8Array(bytes));if(++puts===1)await secondPut;else releaseFirst()};
 const uploads=await Promise.all([1,2].map(()=>f.call('/device/result',{id:DEVICE,job_id:'job-test',result:screenshotResult()},{'x-pc-link-device-key':SECRET})));
 assert.deepEqual(uploads.map(response=>response.status).sort(),[200,409]);
 const row=f.sqlite.prepare('SELECT state,result FROM jobs WHERE id=?').get('job-test');
 assert.equal(row.state,'done');const saved=JSON.parse(row.result);assert.equal(saved.image.stored,true);
 assert.equal(f.images.size,1,'The losing upload must not delete the winning image');
 assert.ok(f.images.has(saved.image.storage_key),'D1 must point to the winning upload’s storage key');
 const result=await imageJob(f);assert.ok(!result.isError);
 assert.equal(result.content.find(item=>item.type==='image')?.data,screenshotData);
 const download=await f.call('/api/image/job-test',undefined,ownerHeaders);assert.equal(download.status,200);
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(screenshotData,'base64'));
});

test('a missing stored screenshot fails explicitly instead of returning successful text-only metadata',async()=>{
 const f=setup();f.job();await f.poll();
 assert.equal((await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:screenshotResult()},{'x-pc-link-device-key':SECRET})).status,200);
 f.images.clear();const result=await imageJob(f);
 assert.equal(result.isError,true);assert.match(result.content.map(item=>item.text||'').join(' '),/image|screenshot/i);
 assert.equal(result.content.some(item=>item.type==='image'),false);
 assert.equal((await f.call('/api/image/job-test',undefined,ownerHeaders)).status,404);
});

test('legacy screenshot storage keys remain readable',async()=>{
 const f=setup();f.job();
 f.sqlite.prepare("UPDATE jobs SET state='done',result=? WHERE id=?").run(JSON.stringify({ok:true,image:{mimeType:'image/png',width:1,height:1,stored:true}}),'job-test');
 f.images.set('screens/job-test',new Uint8Array(Buffer.from(screenshotData,'base64')));
 const result=await imageJob(f);assert.equal(result.content.find(item=>item.type==='image')?.data,screenshotData);
 assert.equal((await f.call('/api/image/job-test',undefined,ownerHeaders)).status,200);
});
test('malformed or unclaimed image results are rejected before R2 writes',async()=>{
 const f=setup();f.job();const hdr={'x-pc-link-device-key':SECRET};
 assert.equal((await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:{image:{data:'/9j/2Q==',mimeType:'image/jpeg',width:2,height:2}}},hdr)).status,409);
 await f.poll();assert.equal((await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:{image:{data:'aGVsbG8=',mimeType:'image/jpeg',width:2,height:2}}},hdr)).status,400);
 assert.equal(f.images.size,0);
});

test('screenshot tools expose an authenticated MCP App resource and model attachment metadata',async()=>{
 const f=setup();const rpc=async(method,params={})=>(await(await f.call('/mcp',{jsonrpc:'2.0',id:1,method,params},ownerHeaders)).json()).result;
 const init=await rpc('initialize');assert.ok(init.capabilities.resources);
 const listed=await rpc('tools/list');const capture=listed.tools.find(t=>t.name==='screenshot'),viewer=listed.tools.find(t=>t.name==='show_screenshot');
 assert.equal(capture._meta.ui.resourceUri,viewer._meta.ui.resourceUri);assert.equal(capture._meta['openai/outputTemplate'],viewer._meta.ui.resourceUri);
 const resources=await rpc('resources/list');assert.ok(resources.resources.some(r=>r.uri===viewer._meta.ui.resourceUri));
 const resource=await rpc('resources/read',{uri:viewer._meta.ui.resourceUri});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');
 assert.equal((await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:viewer._meta.ui.resourceUri}},{})).status,403);
 f.job();await f.poll();await f.call('/device/result',{id:DEVICE,job_id:'job-test',result:screenshotResult()},{'x-pc-link-device-key':SECRET});
 const result=await rpc('tools/call',{name:'show_screenshot',arguments:{job_id:'job-test'}});
 assert.equal(result._meta.screenshot.data,screenshotData);assert.equal(result.content.find(c=>c.type==='image').data,screenshotData);
 assert.equal(result.structuredContent.result.image.data,undefined);
 const other=await(await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'show_screenshot',arguments:{job_id:'job-test'}}},{...ownerHeaders,'oai-authenticated-user-email':'other@example.invalid'})).json();assert.ok(other.error);
});

test('show_screenshot refuses completed jobs without image data',async()=>{
 const f=setup();f.job();f.sqlite.prepare("UPDATE jobs SET state='done',result=? WHERE id=?").run(JSON.stringify({ok:true,stdout:'text only'}),'job-test');
 const result=(await(await f.call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'show_screenshot',arguments:{job_id:'job-test'}}},ownerHeaders)).json()).result;
 assert.equal(result.isError,true);assert.match(result.content[0].text,/no screenshot image/i);
});
