import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sendTransfer, listTransfers, readTransfer, acknowledgeTransfer } from '../worker/mesh.js';

const owner = 'owner@example.test';
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE devices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)');
  db.exec(readFileSync(new URL('../drizzle/0003_overlink_transfers.sql', import.meta.url), 'utf8')
    .replaceAll('--> statement-breakpoint', ''));
  const query = sql => ({
    bind(...args) {
      return {
        async first() { return db.prepare(sql).get(...args) || null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const meta = db.prepare(sql).run(...args); return { meta: { changes: meta.changes } }; }
      };
    }
  });
  db.prepare('INSERT INTO devices (id,owner,revoked) VALUES (?,?,0)').run('pc-a', owner);
  db.prepare('INSERT INTO devices (id,owner,revoked) VALUES (?,?,0)').run('pc-b', owner);
  db.prepare('INSERT INTO devices (id,owner,revoked) VALUES (?,?,0)').run('other-pc', 'other@example.test');
  return { env: { DB: { prepare: query } }, db };
}
test('PC A sends to PC B; only B receives and acknowledges', async () => {
  const {env}=setup();
  const t=await sendTransfer(env,owner,{target_device:'pc-b',title:'Work from PC A',kind:'handoff',content:'Continue feature X',request_id:'handoff1'},'pc-a');
  assert.equal(t.status,'queued');
  assert.equal((await listTransfers(env,owner,'pc-a',true)).transfers.length,0);
  const inbox=(await listTransfers(env,owner,'pc-b',true)).transfers;
  assert.equal(inbox.length,1);
  assert.equal(inbox[0].content,'Continue feature X');
  await assert.rejects(() => readTransfer(env,owner,t.id,'pc-a'),/not found/);
  const receipt=await acknowledgeTransfer(env,owner,t.id,'pc-b');
  assert.equal(receipt.status,'delivered');
  assert.equal((await listTransfers(env,owner,'pc-b',true)).transfers.length,0);
  assert.equal((await readTransfer(env,owner,t.id)).content,'Continue feature X');
});
test('device owner isolation stops cross-account send, read, and acknowledgement',async()=>{
  const {env}=setup();
  await assert.rejects(() => sendTransfer(env,owner,{target_device:'other-pc',content:'x',request_id:'x'}),/not found/);
  const t=await sendTransfer(env,owner,{target_device:'pc-b',content:'hello',request_id:'good'});
  await assert.rejects(() => readTransfer(env,'other@example.test',t.id),/not found/);
  await assert.rejects(() => acknowledgeTransfer(env,owner,t.id,'pc-a'),/not found/);
});
test('idempotent retries and mutation ID conflict detection',async()=>{
  const {env,db}=setup();
  const input={target_device:'pc-b',content:'same',request_id:'retry-1'};
  const a=await sendTransfer(env,owner,input),b=await sendTransfer(env,owner,input);
  assert.equal(a.id,b.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mesh_transfers').get().n,1);
  await assert.rejects(() => sendTransfer(env,owner,{...input,content:'different'}),/reused/);
});
test('files demand valid base64 and basename; transfer never executes commands',async()=>{
  const {env}=setup();
  await assert.rejects(() => sendTransfer(env,owner,{target_device:'pc-b',kind:'file',filename:'../out.exe',content:'YWJj',request_id:'bad1'}),/Invalid file name/);
  await assert.rejects(() => sendTransfer(env,owner,{target_device:'pc-b',kind:'file',filename:'safe.txt',content:'not-base64!',request_id:'bad2'}),/base64/);
  const t=await sendTransfer(env,owner,{target_device:'pc-b',kind:'file',filename:'safe.txt',content:'YWJj',request_id:'ok3'});
  assert.equal((await readTransfer(env,owner,t.id)).content,'YWJj');
});
test('expired queued transfers disappear and cannot be read',async()=>{
  const {env,db}=setup();
  const t=await sendTransfer(env,owner,{target_device:'pc-b',content:'old',request_id:'old'});
  db.prepare('UPDATE mesh_transfers SET expires=? WHERE id=?').run(1,t.id);
  assert.equal((await listTransfers(env,owner,'pc-b',true)).transfers.length,0);
  await assert.rejects(() => readTransfer(env,owner,t.id,'pc-b'),/expired/);
});
