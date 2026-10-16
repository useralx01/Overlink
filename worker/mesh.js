// Overlink transfer protocol. Account-scoped, idempotent and inert: payloads are data, never commands.
const MAX_CONTENT = 90000;
const EXPIRY = 48 * 60 * 60 * 1000;
const kinds = new Set(['text', 'handoff', 'file']);
const err = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const finiteText = (v, max, name) => {
  if (typeof v !== 'string' || !v.length || v.length > max || v.includes('\0')) err('Invalid ' + name);
  return v;
};
const digest = async data =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
const validName = name => {
  if (!name) return '';
  finiteText(name, 180, 'file name');
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,179}$/.test(name) || name.includes('..') || name.endsWith(' ') || name.endsWith('.')) err('Invalid file name');
  return name;
};
const info = row => ({
  id: row.id, from: row.from_device, to: row.target_device, kind: row.kind,
  title: row.title, filename: row.filename || '', bytes: row.bytes, created: row.created,
  expires: row.expires, status: row.state
});

export async function sendTransfer(env, account, input, fromDevice = 'chatgpt') {
  const to = finiteText(input.target_device, 80, 'target device');
  const content = finiteText(input.content, MAX_CONTENT, 'transfer content');
  const requestId = finiteText(input.request_id, 128, 'request_id');
  const kind = input.kind || 'text';
  if (!kinds.has(kind)) err('Invalid transfer kind');
  const title = typeof input.title === 'string' && input.title.length ? finiteText(input.title, 128, 'title') : kind;
  const filename = kind === 'file' ? validName(input.filename) : '';
  if (kind === 'file' && (!filename || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)))
    err('File transfers require a safe filename and base64 content');
  const sender = finiteText(fromDevice, 80, 'sender');
  const device = await env.DB.prepare('SELECT id FROM devices WHERE id=? AND owner=? AND revoked=0')
    .bind(to, account).first();
  if (!device) err('Target computer not found', 404);
  if (sender !== 'chatgpt') {
    const source = await env.DB.prepare('SELECT id FROM devices WHERE id=? AND owner=? AND revoked=0')
      .bind(sender, account).first();
    if (!source) err('Sender computer not found', 403);
  }
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_CONTENT) err('Transfer too large', 413);
  const id = await digest('vyrmesh/v1:' + account + ':' + sender + ':' + requestId);
  const existing = await env.DB.prepare('SELECT * FROM mesh_transfers WHERE id=? AND owner=?')
    .bind(id, account).first();
  if (existing) {
    if (existing.target_device !== to || existing.content !== content || existing.kind !== kind ||
        existing.title !== title || (existing.filename || '') !== filename) err('request_id reused for different transfer', 409);
    return info(existing);
  }
  const created = Date.now(), expires = created + EXPIRY;
  await env.DB.prepare('INSERT OR IGNORE INTO mesh_transfers (id,owner,from_device,target_device,kind,title,filename,content,bytes,created,expires,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, account, sender, to, kind, title, filename, content, bytes, created, expires, 'queued').run();
  const row = await env.DB.prepare('SELECT * FROM mesh_transfers WHERE id=? AND owner=?').bind(id, account).first();
  if (!row || row.target_device !== to || row.content !== content || row.kind !== kind) err('Transfer collision', 409);
  return info(row);
}

export async function listTransfers(env, account, targetDevice = null, includeContent = false) {
  const scope = targetDevice ?
    await env.DB.prepare('SELECT * FROM mesh_transfers WHERE owner=? AND target_device=? AND expires>? ORDER BY created DESC LIMIT 30')
      .bind(account, targetDevice, Date.now()).all() :
    await env.DB.prepare('SELECT * FROM mesh_transfers WHERE owner=? AND expires>? ORDER BY created DESC LIMIT 30')
      .bind(account, Date.now()).all();
  return { transfers: scope.results
    .filter(r => !targetDevice || r.state === 'queued')
    .slice(0, targetDevice ? 3 : 30)
    .map(r => includeContent ? { ...info(r), content: r.content } : info(r)) };
}

export async function readTransfer(env, account, id, targetDevice = null) {
  const row = await env.DB.prepare('SELECT * FROM mesh_transfers WHERE id=? AND owner=?')
    .bind(finiteText(id, 80, 'transfer id'), account).first();
  if (!row || row.expires < Date.now() || (targetDevice && row.target_device !== targetDevice))
    err('Transfer not found or expired', 404);
  return { ...info(row), content: row.content };
}

export async function acknowledgeTransfer(env, account, id, targetDevice = null) {
  const item = await readTransfer(env, account, id, targetDevice);
  if (!targetDevice) targetDevice = item.to;
  await env.DB.prepare("UPDATE mesh_transfers SET state='delivered',delivered=? WHERE id=? AND owner=? AND target_device=? AND state='queued'")
    .bind(Date.now(), item.id, account, targetDevice).run();
  return { ok: true, id: item.id, status: 'delivered' };
}

export const transferTools = [
  {
    name: 'send_transfer',
    description: 'Send selected text, a session handoff, or a small base64 file to another authorized PC. Information only: never executes the content. Keep request_id unchanged on retries. Maximum 90 KB of text.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      target_device: { type: 'string' },
      kind: { type: 'string', enum: ['text','handoff','file'] },
      title: { type: 'string' }, filename: { type: 'string' }, content: { type: 'string' },
      request_id: { type: 'string' }
    }, required: ['target_device','content','request_id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'list_transfers', description: 'List transfer metadata for your own connected computers.',
    inputSchema: { type:'object', properties:{}, additionalProperties:false },
    annotations: {readOnlyHint:true,openWorldHint:false}
  },
  {
    name: 'read_transfer', description: 'Read a transfer sent within your own account.',
    inputSchema: {type:'object',properties:{transfer_id:{type:'string'}},required:['transfer_id'],additionalProperties:false},
    annotations: {readOnlyHint:true,openWorldHint:false}
  },
  {
    name: 'ack_transfer', description: 'Mark a transfer as delivered. Does not execute its content.',
    inputSchema: {type:'object',properties:{transfer_id:{type:'string'}},required:['transfer_id'],additionalProperties:false},
    annotations: {readOnlyHint:false,destructiveHint:false,openWorldHint:false}
  }
];
