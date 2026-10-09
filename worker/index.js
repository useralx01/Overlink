const PAGE = '__PC_LINK_PAGE__';
const APP = '__PC_LINK_APP__';
const SCREENSHOT_WIDGET = '__PC_LINK_SCREENSHOT_WIDGET__';
const SCREENSHOT_URI = 'ui://pc-link/screenshot-v1.html';
const screenshotUi = {ui:{resourceUri:SCREENSHOT_URI,visibility:['model','app']},'openai/outputTemplate':SCREENSHOT_URI,'openai/widgetAccessible':true};
const MAX_BODY = 2300000;
const MAX_RESULT = 2200000;
const QUEUED_LIFE = 300000;
const RUNNING_LIFE = 3600000;
const DAY = 86400000;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 4096) => { if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) fail('Invalid text input'); return value; };
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const serialize = value => JSON.stringify(canonical(value));
async function body(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY) fail('Request too large', 413);
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) fail('Request too large', 413);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('Expected JSON'); }
  if (!object(parsed)) fail('Expected a JSON object');
  return parsed;
}
function owner(req, env) {
  const email = req.headers.get('oai-authenticated-user-email');
  if (!req.headers.get('oai-authenticated-user-id') || email?.toLowerCase() !== env.PC_LINK_OWNER_EMAIL?.toLowerCase()) fail('Sign in with the ChatGPT account that owns PC Link.', 403);
  return email.toLowerCase();
}
function browserMutation(req) {
  if (req.headers.get('origin') !== new URL(req.url).origin || !req.headers.get('content-type')?.startsWith('application/json')) fail('Use the PC Link page to approve actions or change connections.', 403);
}
function capabilities(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  if (!object(value)) return {};
  const encoded = JSON.stringify(value);
  if (encoded.length > 12000) fail('Capabilities metadata is too large');
  return value;
}
async function authorizeDevice(req, env, id) {
  const key = req.headers.get('x-pc-link-device-key');
  if (!key) fail('Device key required', 401);
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').bind(text(id, 80)).first();
  if (!device || device.key_hash !== await hash(key) || device.owner !== env.PC_LINK_OWNER_EMAIL.toLowerCase()) fail('Device authorization expired', 403);
  return device;
}
async function prepareDevice(env, input, account) {
  const id = crypto.randomUUID(), key = random();
  return { config: { id, key, transport: env.PC_LINK_TRANSPORT_TOKEN }, row: { id, key_hash: await hash(key), owner: account, name: text(input.name, 128), root: text(input.root, 2048), terminal: input.terminal ? 1 : 0, capabilities: JSON.stringify(capabilities(input.capabilities)) } };
}
async function insertDevice(env, device) {
  await env.DB.prepare('INSERT INTO devices (id,owner,name,key_hash,root,terminal,last_seen,created,revoked,capabilities) VALUES (?,?,?,?,?,?,?,?,0,?)').bind(device.id, device.owner, device.name, device.key_hash, device.root, device.terminal, 0, Date.now(), device.capabilities).run();
}
async function computers(env, account) {
  const rows = await env.DB.prepare('SELECT id,name,root,terminal,last_seen,capabilities FROM devices WHERE owner=? AND revoked=0 ORDER BY created').bind(account).all();
  return rows.results.map(d => ({ id: d.id, name: d.name, folder: d.root, terminalEnabled: !!d.terminal, capabilities: capabilities(d.capabilities), online: Date.now() - d.last_seen < 45000 }));
}
const browserReads = new Set(['status', 'sessions', 'tabs', 'snapshot', 'screenshot', 'logs', 'downloads']);
const projectReads = new Set(['project_status', 'git_diff', 'language_status', 'lsp_symbols', 'lsp_definition']);
function mutating(operation, args) {
  if (['list', 'read', 'status', 'screen', 'ui_inspect', 'audit', 'task_history'].includes(operation)) return false;
  if (operation === 'windows') return (args.action || 'list') !== 'list';
  if (operation === 'browser') return !browserReads.has(args.action);
  if (operation === 'project') return !projectReads.has(args.action);
  if (operation === 'memory') return !['search', 'memory_search'].includes(args.action);
  if (operation === 'devices') return args.action !== 'mqtt_subscribe' && !(args.action === 'http_request' && ['GET','HEAD'].includes(args.method || 'GET'));
  return true;
}
function checkCapability(device, operation, args) {
  const c = capabilities(device.capabilities);
  if (operation === 'run' && (!device.terminal || c.terminal === false)) fail('Terminal access is disabled on this PC.');
  if (operation === 'write' && c.fileWrite === false) fail('File writing is disabled on this PC.');
  if (['list', 'read', 'write', 'run'].includes(operation)) return;
  if (Number(c.version || 0) < 2) fail('Update the PC Link launcher on this PC to use computer-agent tools.');
  let required;
  if (['screen', 'ui_inspect'].includes(operation) || (operation === 'windows' && !mutating(operation, args))) required = 'desktopView';
  else if (['windows', 'ui_action', 'desktop_input'].includes(operation)) required = 'desktopInput';
  else if (operation === 'browser') required = 'browserControl';
  else if (operation === 'project') required = 'projectTools';
  else if (operation === 'memory') required = 'memory';
  else if (['audit', 'task_history'].includes(operation)) required = 'audit';
  else if (operation === 'devices') required = 'externalDevices';
  if (required && c[required] !== true) fail(`${required} access is disabled. Enable it in the PC Link launcher on that PC.`);
  if (operation === 'browser' && args.action === 'evaluate' && c.browserDebug !== true) fail('Browser JavaScript debugging is disabled. Enable it in the PC Link launcher.');
}
const dashboard = env => env.PC_LINK_ORIGIN || 'https://relay.example.invalid/';
async function result(env, account, id, wait = 9000) {
  const deadline = Date.now() + wait;
  do {
    const job = await env.DB.prepare('SELECT id,state,result,created FROM jobs WHERE id=? AND owner=?').bind(text(id, 80), account).first();
    if (!job) fail('Job not found');
    if (job.state === 'done') return { job_id: job.id, status: 'done', result: job.result ? JSON.parse(job.result) : null };
    if (job.state === 'approval') {
      const details = job.result ? JSON.parse(job.result) : {};
      return { job_id: job.id, status: 'approval', approval_required: true, category: details.category || 'action', summary: details.summary || 'PC Link is waiting for your approval.', approval_url: dashboard(env), next: 'Tell the user to approve or deny in the PC Link dashboard or Windows launcher. The assistant must never approve its own action. After approval, call get_job; do not resubmit.' };
    }
    const life = job.state === 'running' ? RUNNING_LIFE : QUEUED_LIFE;
    if (job.state === 'expired' || Date.now() - job.created > life) return { job_id: job.id, status: 'expired', message: 'This operation expired. Check its local task history before deciding whether to request a new operation. Never automatically repeat a mutation.' };
    if (Date.now() >= deadline) return { job_id: job.id, status: job.state, next: 'Call get_job; do not submit this operation again.' };
    await sleep(600);
  } while (true);
}
async function enqueue(env, account, operation, args) {
  const deviceId = args.device_id || args.computer_id;
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id=? AND owner=? AND revoked=0').bind(text(deviceId, 80), account).first();
  if (!device) fail('Computer not found');
  const mutation = mutating(operation, args);
  const id = mutation ? await hash(account + ':' + device.id + ':' + text(args.request_id, 128)) : crypto.randomUUID();
  const encoded = serialize(args);
  const previous = await env.DB.prepare('SELECT operation,args FROM jobs WHERE id=? AND owner=?').bind(id, account).first();
  if (previous) {
    if (previous.operation !== operation || previous.args !== encoded) fail('Use a new request_id for a different operation.');
    return result(env, account, id);
  }
  if (Date.now() - device.last_seen > 45000) fail('Computer is offline. Open PC Link on that computer.');
  checkCapability(device, operation, args);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE device_id=? AND state IN ('queued','running','approval') AND created>?").bind(device.id, Date.now() - RUNNING_LIFE).first();
  if (count.n >= 20) fail('Too many pending jobs.');
  await env.DB.prepare('INSERT OR IGNORE INTO jobs (id,device_id,owner,operation,args,state,created,approved) VALUES (?,?,?,?,?,?,?,0)').bind(id, device.id, account, operation, encoded, 'queued', Date.now()).run();
  const inserted = await env.DB.prepare('SELECT operation,args FROM jobs WHERE id=? AND owner=?').bind(id, account).first();
  if (!inserted || inserted.operation !== operation || inserted.args !== encoded) fail('Use a new request_id for a different operation.');
  return result(env, account, id);
}
const str = description => ({ type: 'string', description });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const computer = str('Computer ID from list_computers.');
const requestId = str('Unique ID for each intended mutation. Preserve this and all arguments on retries. Required for every action that changes state.');
const deviceArgs = { device_id: computer, args: { type: 'object', description: 'Parameters for the native operation. Do not place action, device_id, request_id, approval flags, or permission flags here.', additionalProperties: true }, request_id: requestId };
const generic = (name, operation, description, readOnly = false, needsAction = true) => ({ name, operation, description: description + (readOnly ? '' : ' Every mutation requires request_id. Approval may be required; the assistant must never approve its own operation.'), inputSchema: schema({ ...deviceArgs, ...(needsAction ? { action: str('Native action name described by this tool.') } : {}) }, ['device_id', ...(needsAction ? ['action'] : [])]), annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: ['browser', 'devices', 'project', 'desktop_input', 'ui_action'].includes(operation) } });
const tools = [
  { name: 'list_computers', description: 'List paired computers, online status, and enabled capabilities. Call before choosing a computer.', inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'list_files', description: 'List files relative to the shared folder.', inputSchema: schema({ computer_id: computer, path: str('Relative folder path; defaults to .') }, ['computer_id']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'read_file', description: 'Read a UTF-8 text file, up to 256 KiB.', inputSchema: schema({ computer_id: computer, path: str('Relative file path.') }, ['computer_id', 'path']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'write_file', description: 'Create or edit a UTF-8 file. Existing files require overwrite=true. Generate a unique request_id and preserve exact arguments on retries. User approval may be required.', inputSchema: schema({ computer_id: computer, path: str('Relative path.'), content: str('Complete text.'), overwrite: { type: 'boolean' }, request_id: requestId }, ['computer_id', 'path', 'content', 'request_id']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'run_command', description: 'Run PowerShell under the Windows user, at most 300 seconds. Terminal can access beyond the shared folder. Use only for the requested task. Preserve request_id and arguments on retries. User approval may be required.', inputSchema: schema({ computer_id: computer, command: str('PowerShell command.'), cwd: str('Relative working folder.'), timeout_seconds: { type: 'integer', minimum: 1, maximum: 300 }, request_id: requestId }, ['computer_id', 'command', 'request_id']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'get_job', description: 'Get a pending result, including images or approval status. Never resubmit a mutation because a result is pending.', inputSchema: schema({ job_id: str('Job ID from the prior operation.') }, ['job_id']), annotations: { readOnlyHint: true, openWorldHint: false },_meta:{ui:{visibility:['model','app']},'openai/widgetAccessible':true} },
  { name:'show_screenshot', description:'Open an existing screenshot in a ChatGPT image attachment widget. Use the screenshot or browser screenshot job_id when regular ChatGPT cannot visually inspect the raw image block. The widget uploads the actual image to the current ChatGPT chat and attaches its returned file ID for the next turn. Do not claim visual inspection before receiving the image. Does not capture another screenshot.',inputSchema:schema({job_id:str('Existing screenshot job ID.')},['job_id']),annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false},_meta:screenshotUi },
  generic('pc_status', 'status', 'Inspect launcher version, runtimes, and capability settings.', true, false),
  generic('screenshot', 'screen', 'See the Windows desktop. args: target (all/primary/monitor/active/window), monitor_index, window_id, max_width (320–1600). A completed result includes an actual MCP image block plus screenshot_id, offsets, and scale for coordinate input. If queued or running, call get_job until complete. Read the image block, not just structuredContent metadata; forward or display it when the user asks to see the screenshot.', true, false),
  generic('windows', 'windows', 'Actions: list, activate, minimize, maximize, restore. Mutation args: window_id from the current window list. list is read-only.'),
  generic('ui_inspect', 'ui_inspect', 'Inspect Windows UI Automation controls. args: window_id, depth, max_elements. Returns snapshot_id and control refs; use current refs for ui_action.', true, false),
  generic('ui_action', 'ui_action', 'Actions: focus, invoke, set_value, select, toggle, expand, collapse. args: snapshot_id, element_id, value for set_value. Use element IDs from a recent ui_inspect result.'),
  generic('desktop_input', 'desktop_input', 'Actions: move, click, scroll, type, key. Coordinate args need x/y and expected_screenshot_id from a recent screenshot. Typing/keys require the current foreground window_id. Interpret image offsets and scale.'),
  generic('browser', 'browser', 'Playwright actions: status, launch (browser edge/chrome), connect (explicitAttach=true, loopback endpoint), sessions, tabs, new_tab, close_tab, goto, snapshot, click, fill, type, press, scroll, evaluate, screenshot, logs, dialog, downloads, save_download, close_session. args use sessionId/pageId. Ref actions require ref and expectedSnapshot=snapshotId. Alternative locator: {role,name}, {label}, {text}, {placeholder}, {testId}, {selector}. Text uses text, key uses key, navigation uses url. evaluate needs locally enabled browserDebug and expression. Managed profiles are separate; Engomo webpages can open by URL. Save downloads with downloadId/path relative to the shared folder.'),
  generic('project', 'project', 'Project/code intelligence actions: project_status, git_diff, language_status, lsp_symbols, lsp_definition. Test runner commands are discovered here and executed with run_command. Paths stay within the selected shared project.'),
  generic('memory', 'memory', 'Explicit project memory actions: search, put, delete. args: query/limit for search; title/text/tags for put; memory_id and optional expected_version for delete. Put/delete require request_id. Do not save secrets or entire chat history.'),
  generic('audit', 'audit', 'Read metadata-only local audit entries. args: limit. Logs omit command contents, typed text, credentials, and memory content.', true, false),
  generic('task_history', 'task_history', 'Read persistent local job states and results. args: job_id, limit. Interrupted mutations are never automatically replayed.', true, false),
  generic('devices', 'devices', 'Actions http_request, mqtt_subscribe, mqtt_publish for named local connections. args.connection selects a local connection; args.path/method/json or topic/payload. Writes require request_id. TLS and locally configured path/topic allowlists apply. No device is discovered or paired automatically.')
];
tools.find(tool=>tool.name==='screenshot')._meta=screenshotUi;
const definitions = new Map(tools.map(tool => [tool.name, tool]));
const operationNames = { list_files: 'list', read_file: 'read', write_file: 'write', run_command: 'run' };
function argumentsFor(name, input) {
  if (!object(input)) fail('Expected tool arguments object');
  if (operationNames[name]) {
    const args = { ...input };
    for (const key of ['approved', '_approved', 'allowJavaScript']) if (key in args) fail('Approval and permission flags are controlled by PC Link.');
    if (['read_file', 'write_file'].includes(name)) text(args.path, 2048);
    if (name === 'write_file' && (typeof args.content !== 'string' || args.content.length > 260000)) fail('Invalid file content');
    if (name === 'run_command') text(args.command, 16000);
    return args;
  }
  const definition = definitions.get(name);
  if (!definition?.operation) fail('Unknown tool');
  const params = input.args === undefined ? {} : input.args;
  if (!object(params)) fail('args must be a JSON object');
  for (const key of ['action', 'device_id', 'computer_id', 'request_id', 'approved', '_approved', 'allowJavaScript']) if (key in params) fail(`Put ${key} only in its documented top-level field; approval and permission flags are not tool arguments.`);
  const args = { ...params, device_id: text(input.device_id, 80) };
  if (input.action !== undefined) args.action = text(input.action, 64);
  if (definition.inputSchema.required.includes('action') && !args.action) fail('Action required');
  if (['approve', 'job_prepare', 'job_complete', 'audit_append'].includes(args.action)) fail('Approval and controller actions are not available through MCP.');
  if (input.request_id !== undefined) args.request_id = text(input.request_id, 128);
  return args;
}
function storedImageKey(jobId, image) {
  const legacy = 'screens/' + text(jobId, 80);
  if (image.storage_key === undefined) return legacy;
  if (typeof image.storage_key !== 'string' || !image.storage_key.startsWith(legacy + '/') || !/^[a-f0-9-]{36}$/.test(image.storage_key.slice(legacy.length + 1))) fail('Invalid stored image reference', 500);
  return image.storage_key;
}
async function mcpContent(env, response) {
  const content = [{ type: 'text', text: JSON.stringify(response) }];
  let screenshot;
  if (response.status === 'done' && response.result?.image?.expired === true) fail('The screenshot image has expired. Take a new screenshot.');
  if (response.status === 'done' && response.result?.image?.stored === true) {
    const blob = await env.IMAGES?.get(storedImageKey(response.job_id, response.result.image));
    if (!blob) fail('The screenshot image is unavailable. Take a new screenshot; image metadata alone is not a visible image.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    screenshot={data:btoa(binary),mimeType:response.result.image.mimeType};
    content.push({type:'image',...screenshot});
  }
  return { content, structuredContent: response,...(screenshot?{_meta:{screenshot}}:{}) };
}
async function mcp(req, env) {
  const request = await body(req), account = owner(req, env);
  const reply = response => json({ jsonrpc: '2.0', id: request.id, result: response });
  if (request.id === undefined) return new Response(null, { status: 202 });
  if (request.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {},resources:{} }, serverInfo: { name: 'PC Link', version: '2.1.0' }, instructions: 'Call list_computers first. Screenshots include actual image blocks and a ChatGPT attachment widget. Metadata alone is not visual input. If you cannot inspect a screenshot, use show_screenshot with its job_id; the widget attaches a genuine uploaded file ID for the next chat turn. Do not claim to see an image until visual input arrives. Use get_job for pending work, never repeat a mutation. Files use the shared folder; PowerShell runs as the Windows user. Inspect before desktop/browser actions and use recent screenshot/UI refs. All mutations need a unique request_id preserved on retries. Approval pending requires the human to approve in their launcher/dashboard; the assistant must never approve its own action.' });
  if (request.method === 'ping') return reply({});
  if (request.method === 'tools/list') return reply({ tools: tools.map(({ operation, ...tool }) => tool) });
  if(request.method==='resources/list')return reply({resources:[{uri:SCREENSHOT_URI,name:'PC Link screenshot',mimeType:'text/html;profile=mcp-app',description:'View and attach a screenshot to the current ChatGPT chat.'}]});
  if(request.method==='resources/read') {
    if(request.params?.uri!==SCREENSHOT_URI)return json({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Unknown UI resource'}});
    return reply({contents:[{uri:SCREENSHOT_URI,mimeType:'text/html;profile=mcp-app',text:SCREENSHOT_WIDGET,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetDescription':'Shows a PC Link screenshot and attaches its uploaded file ID to ChatGPT visual context on the next chat turn.','openai/widgetPrefersBorder':true}}]});
  }
  if (request.method !== 'tools/call') return json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } });
  try {
    const input = request.params?.arguments || {}, name = request.params?.name;
    let response;
    if (name === 'list_computers') response = { computers: await computers(env, account) };
    else if (name === 'get_job' || name==='show_screenshot') {
      response = await result(env, account, input.job_id);
      if(name==='show_screenshot'&&response.status==='done'&&!response.result?.image)fail('This job has no screenshot image.');
    }
    else {
      const definition = definitions.get(name), operation = operationNames[name] || definition?.operation;
      if (!operation) fail('Unknown tool');
      response = await enqueue(env, account, operation, argumentsFor(name, input));
    }
    return reply(await mcpContent(env, response));
  } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
}
async function heartbeat(env, device, input) {
  const cap = input.capabilities === undefined ? device.capabilities : JSON.stringify(capabilities(input.capabilities));
  await env.DB.prepare('UPDATE devices SET last_seen=?,root=?,terminal=?,capabilities=? WHERE id=? AND revoked=0').bind(Date.now(), text(input.root || device.root, 2048), input.terminal === undefined ? device.terminal : input.terminal ? 1 : 0, cap || '{}', device.id).run();
}
async function expire(env, deviceId) {
  await env.DB.prepare("UPDATE jobs SET state='expired' WHERE device_id=? AND ((state='queued' AND created<?) OR (state='running' AND created<?))").bind(deviceId, Date.now() - QUEUED_LIFE, Date.now() - RUNNING_LIFE).run();
}
async function pending(env, account, deviceId) {
  const rows = await env.DB.prepare("SELECT j.id,j.device_id,j.operation,j.args,j.result,j.created,d.name FROM jobs j JOIN devices d ON d.id=j.device_id WHERE j.owner=? AND j.state='approval' AND d.revoked=0" + (deviceId ? ' AND j.device_id=?' : '') + ' ORDER BY j.created LIMIT 100').bind(...(deviceId ? [account, deviceId] : [account])).all();
  return { jobs: rows.results.slice(0,5).map(job => { const details = job.result ? JSON.parse(job.result) : {}; return { job_id: job.id, device_id: job.device_id, computer_name: job.name, operation: job.operation, action: JSON.parse(job.args).action || null, created: job.created, category: details.category || 'action', summary: job.args }; }) };
}
async function approve(env, account, input, deviceId) {
  const id = text(input.job_id, 80);
  if (typeof input.approve !== 'boolean') fail('approve must be a boolean');
  const parameters = input.approve ? [Date.now(), id, account] : [JSON.stringify({ ok: false, denied: true, error: 'User denied this action.' }), Date.now(), id, account];
  if (deviceId) parameters.push(deviceId);
  const query = input.approve ? "UPDATE jobs SET state='queued',approved=1,result=NULL,created=? WHERE id=? AND owner=? AND state='approval'" : "UPDATE jobs SET state='done',result=?,completed=? WHERE id=? AND owner=? AND state='approval'";
  const updated = await env.DB.prepare(query + (deviceId ? ' AND device_id=?' : '') + ' AND EXISTS (SELECT 1 FROM devices WHERE id=jobs.device_id AND revoked=0)').bind(...parameters).run();
  if (!updated.meta.changes) fail('Pending approval not found or already decided', 409);
  return { ok: true, job_id: id, status: input.approve ? 'queued' : 'denied' };
}
async function imageResult(env, jobId, input) {
  const response = { ...input };
  if (!object(response.image)) return { response, stored: false };
  const image = response.image;
  if (typeof image.data !== 'string' || image.data.length > 1400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) fail('Invalid image data');
  if (!['image/jpeg', 'image/png'].includes(image.mimeType)) fail('Unsupported image type');
  if (!Number.isInteger(image.width) || image.width < 1 || image.width > 20000 || !Number.isInteger(image.height) || image.height < 1 || image.height > 20000) fail('Invalid image dimensions');
  const decoded = atob(image.data), bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  if (bytes.length > 1048576) fail('Image is too large', 413);
  const valid = image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  if (!valid) fail('Image signature does not match type');
  if (!env.IMAGES) fail('Image storage is temporarily unavailable', 503);
  // Each upload owns its object, so a losing concurrent result cannot delete
  // the winning result's image during cleanup.
  const key = 'screens/' + jobId + '/' + crypto.randomUUID();
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: image.mimeType } });
  const { data, ...metadata } = image;
  response.image = { ...metadata, stored: true, storage_key: key };
  return { response, stored: true, key };
}
async function cleanup(env) {
  const rows = await env.DB.prepare("SELECT id,result FROM jobs WHERE created<? AND result LIKE '%\"stored\":true%' LIMIT 50").bind(Date.now() - DAY).all();
  for (const job of rows.results) {
    const value = JSON.parse(job.result);
    if (value.image?.stored !== true) continue;
    await env.IMAGES?.delete(storedImageKey(job.id, value.image));
    value.image.stored = false; value.image.expired = true;
    await env.DB.prepare('UPDATE jobs SET result=? WHERE id=?').bind(JSON.stringify(value), job.id).run();
  }
  // Keep mutation tombstones so a delayed retry cannot create another action.
  await env.DB.prepare("DELETE FROM jobs WHERE created<? AND operation IN ('list','read','status','screen','ui_inspect','audit','task_history') AND state IN ('done','expired')").bind(Date.now() - 7 * DAY).run();
}
export default { async fetch(req, env) {
  try {
    const path = new URL(req.url).pathname;
    if (path === '/download' && req.method === 'GET') return new Response(Uint8Array.from(atob(APP), c => c.charCodeAt(0)), { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="PC Link.zip"', 'cache-control': 'no-store' } });
    if (path === '/mcp' && req.method === 'POST') return await mcp(req, env);
    if (path === '/mcp') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (path === '/' || path === '/pair') return new Response(PAGE, { headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; frame-ancestors 'self' https://chatgpt.com" } });
    if (path === '/device/bootstrap' && req.method === 'POST') {
      if (!env.PC_LINK_SETUP_KEY || req.headers.get('x-pc-link-setup') !== env.PC_LINK_SETUP_KEY) fail('Setup denied', 403);
      const input = await body(req), device = await prepareDevice(env, input, env.PC_LINK_OWNER_EMAIL.toLowerCase());
      const inserted = await env.DB.prepare("INSERT OR IGNORE INTO once (name,used) VALUES ('bootstrap',?)").bind(Date.now()).run();
      if (!inserted.meta.changes) fail('Initial setup already used', 409);
      await insertDevice(env, device.row); return json(device.config);
    }
    if (['/device/poll', '/device/heartbeat', '/device/pending', '/device/approve', '/device/result'].includes(path) && req.method === 'POST') {
      const input = await body(req), device = await authorizeDevice(req, env, input.id);
      if (path === '/device/pending') return json(await pending(env, device.owner, device.id));
      if (path === '/device/approve') return json(await approve(env, device.owner, input, device.id));
      if (path === '/device/heartbeat' || path === '/device/poll') {
        await heartbeat(env, device, input); await expire(env, device.id);
        if (path === '/device/heartbeat') return json({ ok: true });
        const job = await env.DB.prepare("UPDATE jobs SET state='running' WHERE id=(SELECT id FROM jobs WHERE device_id=? AND state='queued' AND created>? ORDER BY created LIMIT 1) AND state='queued' AND EXISTS (SELECT 1 FROM devices WHERE id=jobs.device_id AND revoked=0) RETURNING id,operation,args,approved").bind(device.id, Date.now() - QUEUED_LIFE).first();
        return json({ job: job ? { id: job.id, operation: job.operation, args: JSON.parse(job.args), approved: job.approved === 1 } : null });
      }
      if (!object(input.result)) fail('Result must be a JSON object');
      if (new TextEncoder().encode(JSON.stringify(input.result)).length > MAX_RESULT) fail('Result too large', 413);
      const id = text(input.job_id, 80);
      const running = await env.DB.prepare("SELECT id FROM jobs WHERE id=? AND device_id=? AND state='running' AND created>? AND EXISTS (SELECT 1 FROM devices WHERE id=jobs.device_id AND revoked=0)").bind(id, device.id, Date.now() - RUNNING_LIFE).first();
      if (!running) fail('Job not running', 409);
      if (input.result.approval_required === true) {
        const details = { ok: false, approval_required: true, category: typeof input.result.category === 'string' ? input.result.category.slice(0, 80) : 'action', summary: typeof input.result.summary === 'string' ? input.result.summary.slice(0, 1500) : 'Approve this requested action.' };
        const updated = await env.DB.prepare("UPDATE jobs SET state='approval',result=? WHERE id=? AND device_id=? AND state='running' AND approved=0 AND EXISTS (SELECT 1 FROM devices WHERE id=jobs.device_id AND revoked=0)").bind(JSON.stringify(details), id, device.id).run();
        if (!updated.meta.changes) fail('Job no longer eligible for approval', 409);
      } else {
        const image = await imageResult(env, id, input.result);
        const updated = await env.DB.prepare("UPDATE jobs SET state='done',result=?,completed=? WHERE id=? AND device_id=? AND state='running' AND EXISTS (SELECT 1 FROM devices WHERE id=jobs.device_id AND revoked=0)").bind(JSON.stringify(image.response), Date.now(), id, device.id).run();
        if (!updated.meta.changes) { if (image.stored) await env.IMAGES.delete(image.key); fail('Job not running', 409); }
      }
      await cleanup(env); return json({ ok: true });
    }
    const account = owner(req, env);
    if (path === '/api/devices' && req.method === 'GET') return json({ computers: await computers(env, account) });
    if (path === '/api/inspect' && req.method === 'POST') {
      browserMutation(req);const input=await body(req);
      if (!['status','screen'].includes(input.operation)) fail('Only status and screenshot inspection are available here.');
      return json(await enqueue(env,account,input.operation,{device_id:text(input.device_id,80),...(input.operation==='screen'?{target:'primary',max_width:1280}:{})}));
    }
    if (path === '/api/job' && req.method === 'GET') return json(await result(env,account,new URL(req.url).searchParams.get('id'),0));
    if (path === '/api/pending' && req.method === 'GET') return json(await pending(env, account));
    if (path === '/api/approve' && req.method === 'POST') { browserMutation(req); return json(await approve(env, account, await body(req))); }
    if (path.startsWith('/api/image/') && req.method === 'GET') {
      const id = text(path.slice('/api/image/'.length), 80);
      const job = await env.DB.prepare("SELECT result FROM jobs WHERE id=? AND owner=? AND state='done'").bind(id, account).first();
      if (!job || JSON.parse(job.result || '{}').image?.stored !== true) fail('Image not found', 404);
      const image = JSON.parse(job.result).image;
      const blob = await env.IMAGES?.get(storedImageKey(id, image)); if (!blob) fail('Image not found', 404);
      return new Response(await blob.arrayBuffer(), { headers: { 'content-type': image.mimeType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (path === '/api/revoke' && req.method === 'POST') { browserMutation(req); const input = await body(req); await env.DB.prepare('UPDATE devices SET revoked=1 WHERE id=? AND owner=?').bind(text(input.id, 80), account).run(); return json({ ok: true }); }
    if (path === '/api/pair' && req.method === 'POST') {
      browserMutation(req); const input = await body(req);
      if (input.publicKey?.kty !== 'RSA') fail('Missing computer key');
      const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: text(input.publicKey.n, 1000), e: text(input.publicKey.e, 20), ext: true }, { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['encrypt']);
      const device = await prepareDevice(env, input, account), raw = new TextEncoder().encode(JSON.stringify(device.config));
      if (raw.length > 470) fail('Pairing configuration is too large');
      const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw);
      await insertDevice(env, device.row); return json({ sealed: btoa(String.fromCharCode(...new Uint8Array(encrypted))) });
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('PC Link request:', error.status || 500, error.status ? error.message : 'internal error');
    return json({ error: error.status ? error.message : 'PC Link is temporarily unavailable.' }, error.status || 500);
  }
} };
