import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';

// Only the local launcher owns this process. There is no network listener or model API.
// User browser cookies/passwords are never loaded from existing personal profiles.
const LIMIT = 290000;
const TIMEOUT = 8000;
const sessions = new Map();
const pageIds = new WeakMap();
const pageState = new WeakMap();
let pwSeq = 0;
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const profiles = path.join(localAppData, 'PC Link', 'browser profiles');

function str(value, name, max = 4000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${name}`);
  return value;
}
function integer(value, fallback, min, max) {
  const v = value === undefined ? fallback : value;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Number must be between ${min} and ${max}`);
  return v;
}
function trim(value, max = 12000) {
  const s = String(value ?? '');
  return s.length <= max ? s : s.slice(0, max) + '\n[truncated]';
}
function errorResult(error) {
  const message = error?.name === 'TimeoutError' ? 'Browser operation timed out. Inspect the current page or pending dialog before retrying.' : trim(String(error?.message || 'Browser operation failed').split('\n')[0], 350);
  return { error: message };
}
function ensureURL(value) {
  const input = str(value, 'URL', 12000);
  let u;
  try { u = new URL(input); } catch { throw new Error('Use a full http:// or https:// URL'); }
  if (!['http:', 'https:'].includes(u.protocol) && input !== 'about:blank') throw new Error('Navigation accepts HTTP, HTTPS, or about:blank. Serve local files on localhost.');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not accepted');
  return u.href;
}
export function checkCDP(value) {
  const input = str(value, 'CDP endpoint', 2000);
  let u;
  try { u = new URL(input); } catch { throw new Error('Invalid CDP endpoint'); }
  if (!/^(?:http|ws):\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+(?:\/|$)/.test(input) || !['http:', 'ws:'].includes(u.protocol) || !['127.0.0.1', '[::1]'].includes(u.hostname) || !u.port || u.username || u.password || u.hash || u.search) throw new Error('CDP must use an explicit 127.0.0.1 or [::1] HTTP/WS endpoint and port');
  if (u.protocol === 'http:' && u.pathname !== '/') throw new Error('HTTP CDP endpoint must have no path');
  if (u.protocol === 'ws:' && !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(u.pathname)) throw new Error('Invalid CDP WebSocket endpoint path');
  return u.href;
}
async function directCDP(endpoint) {
  const url = new URL(checkCDP(endpoint));
  if (url.protocol === 'ws:') return url.href;
  // Do not let an HTTP CDP discovery response redirect or advertise a remote host.
  const version = await new Promise((resolve, reject) => {
    const req = httpGet(new URL('/json/version', url), { timeout: 5000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Local CDP discovery failed or returned a redirect')); return; }
      let body = '';
      response.on('data', chunk => { body += chunk.toString('utf8'); if (body.length > 20000) req.destroy(new Error('CDP discovery response is too large')); });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid CDP discovery response')); } });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Local CDP discovery timed out')));
    req.on('error', reject);
  });
  const socket = new URL(checkCDP(version.webSocketDebuggerUrl));
  if (socket.protocol !== 'ws:' || socket.hostname !== url.hostname || socket.port !== url.port) throw new Error('CDP discovery advertised a different host or port');
  return socket.href;
}
export async function confinedFile(root, relative) {
  str(root, 'shared folder', 3000);
  str(relative, 'download path', 1500);
  if (!path.isAbsolute(root)) throw new Error('The shared folder must be absolute');
  // Refuse Windows drive-relative paths, ADS, device paths, and traversal.
  if (path.isAbsolute(relative) || /[:\x00-\x1f]/.test(relative) || /(^|[\\/])\.\.([\\/]|$)/.test(relative)) throw new Error('Download path must stay inside the shared folder');
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some(s => /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('Invalid Windows download filename');
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const inside = path.relative(base, target);
  if (!inside || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('Download path must stay inside the shared folder');
  const canonicalBase = await fs.realpath(base);
  if ((await fs.lstat(base)).isSymbolicLink()) throw new Error('Shared folder cannot be a junction or symbolic link');
  let cursor = base;
  for (const component of segments) {
    cursor = path.join(cursor, component);
    try {
      const st = await fs.lstat(cursor);
      if (st.isSymbolicLink()) throw new Error('Downloads cannot cross a junction or symbolic link');
      const real = await fs.realpath(cursor);
      const rel = path.relative(canonicalBase, real);
      if (rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Download resolved outside the shared folder');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return target;
}
function watchPage(session, page) {
  if (pageIds.has(page)) return;
  const pageId = 'page-' + (++pwSeq);
  pageIds.set(page, pageId);
  const state = { snapshot: null, logs: [], dialog: null };
  pageState.set(page, state);
  const log = (type, text) => {
    state.logs.push({ time: new Date().toISOString(), type, text: trim(text, 1800) });
    if (state.logs.length > 150) state.logs.shift();
  };
  page.on('console', msg => log(msg.type(), msg.text()));
  page.on('pageerror', error => log('pageerror', error.message));
  page.on('requestfailed', req => log('requestfailed', `${req.method()} ${trim(req.url(), 500)}: ${req.failure()?.errorText || 'failed'}`));
  page.on('framenavigated', () => { state.snapshot = null; });
  page.on('close', () => { state.snapshot = null; });
  page.on('dialog', dialog => {
    state.dialog = dialog;
    log('dialog', `${dialog.type()}: ${dialog.message()}`);
  });
  page.on('download', download => {
    const downloadId = 'download-' + randomUUID();
    session.downloads.set(downloadId, { download, pageId, name: trim(download.suggestedFilename(), 200), time: new Date().toISOString() });
    if (session.downloads.size > 30) {
      const oldest = session.downloads.keys().next().value;
      session.downloads.get(oldest)?.download.cancel().catch(() => {});
      session.downloads.delete(oldest);
    }
  });
}
function watchContext(session) {
  session.context.setDefaultTimeout(TIMEOUT);
  session.context.setDefaultNavigationTimeout(12000);
  session.context.on('page', page => watchPage(session, page));
  session.context.on('close', () => { session.closed = true; sessions.delete(session.id); });
  for (const page of session.context.pages()) watchPage(session, page);
}
function getSession(args) {
  const session = sessions.get(str(args.sessionId, 'sessionId', 80));
  if (!session || session.closed) throw new Error('Browser session is unavailable. Call status or launch.');
  return session;
}
function getPage(session, args) {
  const id = str(args.pageId, 'pageId', 80);
  const page = session.context.pages().find(p => pageIds.get(p) === id && !p.isClosed());
  if (!page) throw new Error('Tab is unavailable. Call tabs.');
  return page;
}
async function tabInfo(page) {
  let timer;
  const title = await Promise.race([page.title().catch(() => ''), new Promise(resolve => { timer = setTimeout(() => resolve('[title unavailable]'), 1500); })]).finally(() => clearTimeout(timer));
  return { pageId: pageIds.get(page), url: trim(page.url(), 5000), title: trim(title, 500), pendingDialog: pageState.get(page)?.dialog ? { type: pageState.get(page).dialog.type(), message: trim(pageState.get(page).dialog.message(), 1500) } : null };
}
function locatorFor(page, args) {
  const state = pageState.get(page);
  if (args.ref !== undefined) {
    str(args.ref, 'ref', 60);
    if (!/^(?:f\d+)?e\d+$/.test(args.ref)) throw new Error('Invalid element reference');
    if (!state.snapshot || args.expectedSnapshot !== state.snapshot) throw new Error('Stale element reference. Take a new snapshot and use its snapshotId.');
    return page.getByRef(args.ref);
  }
  const l = args.locator;
  if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error('Provide a snapshot ref and expectedSnapshot, or a locator object');
  const types = ['role', 'text', 'label', 'placeholder', 'testId', 'selector'].filter(k => l[k] !== undefined);
  if (types.length !== 1) throw new Error('Locator must contain exactly one of role, text, label, placeholder, testId, selector');
  let locator;
  const key = types[0], value = str(l[key], `locator ${key}`, 2000);
  const options = { exact: l.exact !== false };
  if (key === 'role') {
    if (l.name !== undefined) options.name = str(l.name, 'accessible name', 2000, true);
    locator = page.getByRole(value, options);
  } else if (key === 'text') locator = page.getByText(value, options);
  else if (key === 'label') locator = page.getByLabel(value, options);
  else if (key === 'placeholder') locator = page.getByPlaceholder(value, options);
  else if (key === 'testId') locator = page.getByTestId(value);
  else locator = page.locator(value);
  if (l.nth !== undefined) locator = locator.nth(integer(l.nth, 0, 0, 1000));
  return locator;
}
async function snapshot(page, args = {}) {
  const state = pageState.get(page);
  const snapshotId = randomUUID();
  const content = await page.ariaSnapshot({ mode: 'ai', depth: integer(args.depth, 10, 1, 30), timeout: TIMEOUT });
  state.snapshot = snapshotId;
  return { ...(await tabInfo(page)), snapshotId, content: trim(content, integer(args.maxChars, 25000, 1000, 70000)), instructions: 'Use ref with expectedSnapshot=snapshotId. Take a new snapshot after navigation or an action.' };
}
function jpegSize(bytes) {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    if (length < 2) break;
    offset += 2 + length;
  }
  throw new Error('Screenshot dimensions unavailable');
}
async function screen(page, args) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const clip = { x: 0, y: 0, width: Math.min(size.width, 1600), height: Math.min(size.height, 1100) };
  let bytes;
  for (const quality of [55, 35, 20]) {
    bytes = await page.screenshot({ type: 'jpeg', quality, scale: 'css', clip, timeout: TIMEOUT });
    if (bytes.length < 180000) break;
  }
  if (bytes.length >= 180000) throw new Error('Screenshot is too large. Reduce the browser viewport or use a DOM snapshot.');
  return { ...(await tabInfo(page)), image: { data: bytes.toString('base64'), mimeType: 'image/jpeg', ...jpegSize(bytes) }, cropped: size.width > clip.width || size.height > clip.height };
}
async function closeSession(session) {
  // A connected browser.close disconnects this client; a managed context closes our own browser.
  if (session.managed) await session.context.close();
  else await session.browser.close();
  session.closed = true;
  sessions.delete(session.id);
}
async function closeAll() {
  await Promise.allSettled([...sessions.values()].filter(s => !s.closed).map(closeSession));
}

export const browserActions = ['batch', 'status', 'launch', 'connect', 'sessions', 'tabs', 'new_tab', 'close_tab', 'goto', 'snapshot', 'click', 'fill', 'type', 'press', 'scroll', 'evaluate', 'screenshot', 'logs', 'dialog', 'downloads', 'save_download', 'close_session'];
export async function handleBrowser(args, root) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid browser arguments');
  const action = str(args.action, 'browser action', 40);
  if (!browserActions.includes(action)) throw new Error('Unknown browser action');
  if (action === 'batch') {
    const steps = args.steps;
    const permitted = new Set(['goto','click','fill','type','press','scroll']);
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 6)
      throw new Error('Browser batch requires between 1 and 6 actions');
    if (!args.sessionId || !args.pageId) throw new Error('Browser batch requires existing sessionId and pageId');
    let totalText = 0;
    for (const step of steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || !permitted.has(step.action))
        throw new Error('Batch supports only goto, click, fill, type, press, or scroll');
      for (const key of ['sessionId','pageId','allowJavaScript','expression','root','steps']) {
        if (Object.prototype.hasOwnProperty.call(step,key))
          throw new Error('Nested batch operation cannot override session, page or permissions');
      }
      totalText += typeof step.text === 'string' ? step.text.length : 0;
    }
    if (totalText > 3000) throw new Error('Batch text exceeds input limit');
    const completed=[];
    for (let index=0; index<steps.length; index++) {
      const step=steps[index];
      try {
        const result=await handleBrowser({
          ...step, sessionId:args.sessionId, pageId:args.pageId, allowJavaScript:false
        }, root);
        completed.push({index,action:step.action,ok:true,...(result.httpStatus !== undefined ? {httpStatus:result.httpStatus}:{})});
      } catch(error) {
        return {ok:false,partial:true,completed,failed_step:index,
          error:String(error.message || error).slice(0,300),
          next:'Inspect the current page. Never replay an uncertain browser mutation blindly.'};
      }
    }
    try {
      const current = await handleBrowser({
        sessionId:args.sessionId,pageId:args.pageId,action:'snapshot',limit:12000
      },root);
      return {ok:true,count:completed.length,completed,snapshot:current};
    } catch(error) {
      return {ok:true,count:completed.length,completed,
        snapshot_error:String(error.message || error).slice(0,200)};
    }
  }
  if (action === 'status' || action === 'sessions') {
    const installed = [];
    const candidates = {
      edge: [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      chrome: [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]
    };
    for (const [name, paths] of Object.entries(candidates)) if ((await Promise.all(paths.map(p => fs.access(p).then(() => true).catch(() => false)))).some(Boolean)) installed.push(name);
    return { version: '2.0.0', playwright: '1.64.0', installed, sessions: await Promise.all([...sessions.values()].filter(s => !s.closed).map(async s => ({ sessionId: s.id, browser: s.name, managed: s.managed, tabs: await Promise.all(s.context.pages().filter(p => !p.isClosed()).map(tabInfo)) }))), profileNote: 'Managed Edge/Chrome use a separate persistent PC Link profile. Sign into websites there once. Engomo websites work as URLs; another Chromium browser can connect only through an explicitly provided loopback CDP endpoint.' };
  }
  if (action === 'launch') {
    if (sessions.size >= 4 && [...sessions.values()].filter(s => !s.closed).length >= 4) throw new Error('Close a browser session before launching another');
    const name = args.browser || 'edge';
    if (!['edge', 'chrome'].includes(name)) throw new Error('Managed browsers are edge or chrome. Other Chromium browsers require explicit CDP connect.');
    if ([...sessions.values()].some(s => !s.closed && s.managed && s.name === name)) throw new Error('This managed browser is already running. Use its existing sessionId.');
    const profile = path.join(profiles, name);
    await fs.mkdir(profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, { channel: name === 'edge' ? 'msedge' : 'chrome', headless: args.headless === true, viewport: { width: 1280, height: 900 }, acceptDownloads: true, timeout: 18000, chromiumSandbox: true });
    const session = { id: 'browser-' + randomUUID(), name, managed: true, context, browser: context.browser(), downloads: new Map(), closed: false };
    sessions.set(session.id, session); watchContext(session);
    if (!context.pages().length) await context.newPage();
    return { sessionId: session.id, browser: name, managed: true, tabs: await Promise.all(context.pages().map(tabInfo)) };
  }
  if (action === 'connect') {
    if (args.explicitAttach !== true) throw new Error('Attaching to an existing browser requires explicitAttach=true and a loopback CDP endpoint');
    if ([...sessions.values()].filter(s => !s.closed).length >= 4) throw new Error('Close a browser session before connecting another');
    const endpoint = await directCDP(args.endpoint);
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000, noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) { await browser.close(); throw new Error('No browser context is available'); }
    const session = { id: 'browser-' + randomUUID(), name: 'attached-chromium', managed: false, context, browser, downloads: new Map(), closed: false };
    sessions.set(session.id, session); watchContext(session);
    return { sessionId: session.id, managed: false, tabs: await Promise.all(context.pages().map(tabInfo)) };
  }
  const session = getSession(args);
  if (action === 'tabs') return { sessionId: session.id, tabs: await Promise.all(session.context.pages().filter(p => !p.isClosed()).map(tabInfo)) };
  if (action === 'close_session') { await closeSession(session); return { closed: true, sessionId: session.id }; }
  if (action === 'new_tab') {
    const page = await session.context.newPage();
    if (args.url) await page.goto(ensureURL(args.url), { waitUntil: 'domcontentloaded', timeout: 12000 });
    return { sessionId: session.id, ...(await tabInfo(page)) };
  }
  if (action === 'downloads') return { downloads: [...session.downloads].map(([downloadId, d]) => ({ downloadId, pageId: d.pageId, filename: d.name, time: d.time })) };
  if (action === 'save_download') {
    const d = session.downloads.get(str(args.downloadId, 'downloadId', 80));
    if (!d) throw new Error('Download is unavailable. Call downloads.');
    const destination = await confinedFile(root, args.path);
    let exists = false; try { await fs.lstat(destination); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (exists && args.overwrite !== true) throw new Error('File already exists. Choose a new path or explicitly set overwrite=true.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Recheck the created parents immediately before writing.
    await confinedFile(root, args.path);
    const cancelTimer = setTimeout(() => d.download.cancel().catch(() => {}), 15000);
    try { await d.download.saveAs(destination); } finally { clearTimeout(cancelTimer); }
    const info = await fs.stat(destination);
    return { saved: args.path, bytes: info.size };
  }
  const page = getPage(session, args);
  const state = pageState.get(page);
  if (action === 'close_tab') { await page.close({ runBeforeUnload: false }); return { closed: true, pageId: args.pageId }; }
  if (action === 'snapshot') return await snapshot(page, args);
  if (action === 'screenshot') return await screen(page, args);
  if (action === 'logs') {
    const count = integer(args.limit, 50, 1, 150);
    const logs = state.logs.slice(-count);
    if (args.clear === true) state.logs = [];
    return { pageId: args.pageId, logs };
  }
  if (action === 'dialog') {
    if (!state.dialog) return { pending: false };
    const dialog = state.dialog;
    const kind = str(args.response, 'dialog response', 20);
    if (kind === 'accept') await dialog.accept(args.promptText === undefined ? undefined : str(args.promptText, 'prompt text', 4000, true));
    else if (kind === 'dismiss') await dialog.dismiss();
    else throw new Error('Dialog response is accept or dismiss');
    state.dialog = null; state.snapshot = null;
    return { handled: true };
  }
  if (state.dialog) throw new Error('A browser dialog is pending. Use dialog with response=accept or dismiss.');
  if (action === 'goto') {
    state.snapshot = null;
    const response = await page.goto(ensureURL(args.url), { waitUntil: 'domcontentloaded', timeout: 12000 });
    return { ...(await tabInfo(page)), httpStatus: response?.status() ?? null };
  }
  if (action === 'evaluate') {
    if (args.allowJavaScript !== true) throw new Error('Browser JavaScript debugging permission is required');
    const expression = str(args.expression, 'JavaScript expression', 20000);
    state.snapshot = null;
    let timer;
    const pending = page.evaluate(expression, args.argument);
    try {
      const value = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('JavaScript timed out. Reload or close this managed tab before continuing.')), TIMEOUT); })]);
      const serialized = JSON.stringify(value ?? null);
      if (serialized.length > 60000) return { value: trim(serialized, 60000), truncated: true };
      return { value: value ?? null };
    } catch (e) {
      if (e.message?.startsWith('JavaScript timed out')) {
        // Cancels stalled evaluate on our managed page; never closes a user's attached tab.
        if (session.managed) await page.close({ runBeforeUnload: false }).catch(() => {});
        else session.blocked = true;
      }
      throw e;
    } finally { clearTimeout(timer); }
  }
  if (session.blocked) throw new Error('Attached browser evaluation timed out. Disconnect and reconnect after the user resolves that page.');
  try {
    if (action === 'scroll') {
      if (args.ref || args.locator) {
        const locator = locatorFor(page, args);
        await locator.scrollIntoViewIfNeeded({ timeout: TIMEOUT });
      } else await page.mouse.wheel(integer(args.deltaX, 0, -10000, 10000), integer(args.deltaY, 600, -10000, 10000));
    } else if (action === 'press' && !args.ref && !args.locator) {
      await page.keyboard.press(str(args.key, 'key', 100));
    } else {
      const locator = locatorFor(page, args);
      if (action === 'click') await locator.click({ timeout: TIMEOUT, button: args.button || 'left', clickCount: integer(args.clickCount, 1, 1, 2) });
      else if (action === 'fill') await locator.fill(str(args.text, 'text', 20000, true), { timeout: TIMEOUT });
      else if (action === 'type') await locator.pressSequentially(str(args.text, 'text', 10000, true), { timeout: TIMEOUT, delay: integer(args.delayMs, 0, 0, 50) });
      else if (action === 'press') await locator.press(str(args.key, 'key', 100), { timeout: TIMEOUT });
      else throw new Error('Unsupported browser action');
    }
  } finally {
    // An action can partly complete before a timeout. Never encourage repeating a stale write.
    state.snapshot = null;
  }
  return { acted: action, ...(await tabInfo(page)), next: 'Take a snapshot to inspect the resulting page.' };
}

async function selfTest() {
  // This browser is headless and uses a disposable profile; no personal tab is touched.
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-link-browser-test-'));
  const fixture = `<!doctype html><title>PC Link fixture</title><label>Name<input id="name"></label><button onclick="document.querySelector('#result').textContent=document.querySelector('#name').value;console.log('fixture clicked')">Save</button><p id="result">Ready</p><a href="/download" download="fixture.txt">Download fixture</a>`;
  const server = createServer((req, res) => {
    if (req.url === '/download') { res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="fixture.txt"' }); res.end('PC Link download fixture'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    for (const endpoint of ['http://evil.example:9222', 'http://127.0.0.1.evil.example:9222', 'http://localhost:9222', 'http://127.0.0.1:9222/path', 'http://user:password@127.0.0.1:9222', 'http://127.1:9222']) {
      assert.throws(() => checkCDP(endpoint));
    }
    assert.equal(checkCDP('http://127.0.0.1:9222'), 'http://127.0.0.1:9222/');
    await assert.rejects(() => confinedFile(temp, '../escape.txt'));
    await assert.rejects(() => confinedFile(temp, 'file.txt:stream'));
    await assert.rejects(() => confinedFile(temp, 'NUL.txt'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-link-browser-outside-'));
    try {
      await fs.symlink(outside, path.join(temp, 'junction'), 'junction');
      await assert.rejects(() => confinedFile(temp, 'junction/escaped.txt'));
    } finally { await fs.rm(path.join(temp, 'junction'), { force: true }).catch(() => {}); await fs.rm(outside, { recursive: true, force: true }); }
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), { channel: 'msedge', headless: true, viewport: { width: 1100, height: 760 }, acceptDownloads: true, timeout: 18000 });
    const s = { id: 'self-test', name: 'edge', managed: true, context, browser: context.browser(), downloads: new Map(), closed: false };
    sessions.set(s.id, s); watchContext(s);
    const page = context.pages()[0] || await context.newPage();
    const base = { sessionId: s.id, pageId: pageIds.get(page) };
    await handleBrowser({ ...base, action: 'goto', url: `http://127.0.0.1:${server.address().port}` }, temp);
    let snap = await handleBrowser({ ...base, action: 'snapshot' }, temp);
    assert.match(snap.content, /button "Save"/);
    const nameRef = snap.content.match(/textbox[^\n]*\[ref=(\w+)\]/)?.[1];
    assert.ok(nameRef, 'snapshot includes textbox ref');
    await handleBrowser({ ...base, action: 'fill', ref: nameRef, expectedSnapshot: snap.snapshotId, text: 'Browser test passed' }, temp);
    await assert.rejects(() => handleBrowser({ ...base, action: 'fill', ref: nameRef, expectedSnapshot: snap.snapshotId, text: 'stale' }, temp), /Stale/);
    await handleBrowser({ ...base, action: 'click', locator: { role: 'button', name: 'Save' } }, temp);
    assert.equal(await page.locator('#result').innerText(), 'Browser test passed');
    const batched = await handleBrowser({...base, action:'batch', steps:[
      {action:'fill',locator:{role:'textbox',name:'Name'},text:'Batch test passed'},
      {action:'click',locator:{role:'button',name:'Save'}}
    ]},temp);
    assert.equal(batched.ok,true);
    assert.equal(batched.count,2);
    assert.equal(await page.locator('#result').innerText(),'Batch test passed');
    await assert.rejects(()=>handleBrowser({...base,action:'batch',steps:[
      {action:'evaluate',expression:'window.location.href'}
    ]},temp),/Batch supports/);

    const img = await handleBrowser({ ...base, action: 'screenshot' }, temp);
    assert.equal(img.image.mimeType, 'image/jpeg'); assert.equal(img.image.width, 1100); assert.ok(Buffer.from(img.image.data, 'base64').length < 180000);
    await assert.rejects(() => handleBrowser({ ...base, action: 'evaluate', expression: 'document.title' }, temp), /permission/);
    assert.equal((await handleBrowser({ ...base, action: 'evaluate', allowJavaScript: true, expression: 'document.title' }, temp)).value, 'PC Link fixture');
    const logs = await handleBrowser({ ...base, action: 'logs' }, temp); assert.ok(logs.logs.some(l => l.text === 'fixture clicked'));
    await Promise.all([page.waitForEvent('download'), handleBrowser({ ...base, action: 'click', locator: { role: 'link', name: 'Download fixture' } }, temp)]);
    const ds = await handleBrowser({ action: 'downloads', sessionId: s.id }, temp); assert.equal(ds.downloads.length, 1);
    await handleBrowser({ action: 'save_download', sessionId: s.id, downloadId: ds.downloads[0].downloadId, path: 'downloads/fixture.txt' }, temp);
    assert.equal(await fs.readFile(path.join(temp, 'downloads', 'fixture.txt'), 'utf8'), 'PC Link download fixture');
    await assert.rejects(() => handleBrowser({ action: 'save_download', sessionId: s.id, downloadId: ds.downloads[0].downloadId, path: '../escaped.txt' }, temp));
    return { passed: true, checks: ['loopback CDP validation', 'download traversal/ADS/reserved-name/junction refusal', 'managed Edge launch', 'ARIA refs and stale-ref refusal', 'fill and click', 'JPEG screenshot', 'JavaScript permission', 'console logging', 'download restricted to shared folder'] };
  } finally {
    if (context) await context.close().catch(() => {});
    sessions.delete('self-test');
    await new Promise(resolve => server.close(resolve));
    // Every test path came from mkdtemp under the OS temp root.
    const resolved = path.resolve(temp);
    if (!path.relative(path.resolve(os.tmpdir()), resolved).startsWith('..') && path.basename(resolved).startsWith('pc-link-browser-test-')) await fs.rm(resolved, { recursive: true, force: true });
  }
}
async function runWorker() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let queue = Promise.resolve(), pending = 0;
  function emit(id, result) {
    let serialized = JSON.stringify({ id, result });
    if (serialized.length > LIMIT) serialized = JSON.stringify({ id, result: { error: 'Browser result exceeded the size limit. Request a smaller snapshot or log limit.' } });
    process.stdout.write(serialized + '\n');
  }
  rl.on('line', line => {
    let message;
    try {
      if (line.length > 100000) throw new Error('Browser request is too large');
      message = JSON.parse(line);
      if (!message || !['string', 'number'].includes(typeof message.id) || String(message.id).length > 80) throw new Error('Invalid request id');
      if (message.operation !== 'browser') throw new Error('Browser worker accepts operation=browser');
      if (pending >= 16) throw new Error('Browser queue is full');
    } catch (error) { emit(message?.id ?? null, errorResult(error)); return; }
    pending++;
    queue = queue.then(async () => {
      try { emit(message.id, await handleBrowser(message.args, message.root)); }
      catch (error) { emit(message.id, errorResult(error)); }
      finally { pending--; }
    });
  });
  rl.on('close', () => { queue.finally(async () => { await closeAll(); process.exit(0); }); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { closeAll().finally(() => process.exit(0)); });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--self-test')) {
    selfTest().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stdout.write(JSON.stringify(errorResult(error)) + '\n'); process.exitCode = 1; });
  } else runWorker();
}
