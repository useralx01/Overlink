import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Executes the actual Site HTML script. The host below is a deterministic mock;
// passing these tests does not verify that a real ChatGPT host permits uploading
// a server-produced screenshot or that the real model receives its pixels.
const widgetUrl = new URL('../worker/screenshot-widget.html', import.meta.url);
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmFcAAAAASUVORK5CYII=';
const genuineId = 'file_mock-host-returned-screenshot';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function completed(jobId = 'job-widget-test') {
  const response = {
    job_id: jobId,
    status: 'done',
    result: {
      ok: true,
      screenshot_id: 'capture-distinct-from-file-id',
      window_id: 'window-test',
      image: {
        stored: true,
        mimeType: 'image/png',
        width: 1,
        height: 1,
        offsetX: -1920,
        offsetY: 40,
        scale: 0.5,
        sourceWidth: 2,
        sourceHeight: 2,
      },
      coordinates: 'screenX = offsetX + imageX / scale; screenY = offsetY + imageY / scale',
    },
  };
  return {
    structuredContent: response,
    content: [
      { type: 'text', text: JSON.stringify(response) },
      { type: 'image', data: pngBase64, mimeType: 'image/png' },
    ],
  };
}

function pending(status = 'queued', jobId = 'job-widget-test') {
  const response = { job_id: jobId, status, next: 'Call get_job; do not submit this operation again.' };
  return { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] };
}

class Surface {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event.type) ?? []) handler.call(this, event);
    this[`on${event.type}`]?.call(this, event);
    return true;
  }
}

class Element extends Surface {
  constructor(tagName, id = '') {
    super();
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.textContent = '';
    this.innerHTML = '';
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const present = force ?? !classes.has(name);
        present ? classes.add(name) : classes.delete(name);
        return present;
      },
    };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  click() {
    if (!this.disabled) this.dispatchEvent({ type: 'click', target: this, preventDefault() {} });
  }
}

async function boot({ initial, savedState, omit = [], upload, persist, followUp, callTool } = {}) {
  const html = await readFile(widgetUrl, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1])).map(match => match[2]);
  assert.ok(scripts.length, 'Widget must contain a real inline script to execute');
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid\s*=\s*["']([^"']+)["'][^>]*)>/gi)) {
    const element = new Element(match[1], match[3]);
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(element.id, element);
  }
  const allElements = [...elements.values()];
  const document = new Surface();
  document.readyState = 'complete';
  document.body = new Element('body');
  document.documentElement = new Element('html');
  document.getElementById = id => elements.get(id) ?? null;
  document.querySelector = selector => selector.startsWith('#') ? elements.get(selector.slice(1)) ?? null : null;
  document.querySelectorAll = selector => selector === 'button' ? allElements.filter(e => e.tagName === 'BUTTON') : [];
  document.createElement = tag => { const element = new Element(tag); allElements.push(element); return element; };
  const calls = { upload: [], states: [], followUp: [], tools: [], events: [] };
  const timers = new Map();
  let timerId = 0, clock = 0;
  const openai = {
    async uploadFile(file, options) {
      calls.upload.push({ file, options }); calls.events.push('upload');
      return upload ? upload(file, options) : { fileId: genuineId };
    },
    setWidgetState(state) {
      calls.states.push(clone(state)); calls.events.push('state');
      const result = persist?.(state);
      openai.widgetState = clone(state);
      return result;
    },
    async sendFollowUpMessage(message) {
      calls.followUp.push(clone(message)); calls.events.push('follow-up');
      return followUp?.(message);
    },
    async callTool(name, args) {
      calls.tools.push({ name, args: clone(args) }); calls.events.push(`tool:${name}`);
      assert.equal(name, 'get_job', 'The widget must never take a second screenshot');
      return callTool ? callTool(name, args) : completed(args.job_id);
    },
    widgetState: clone(savedState) ?? null,
  };
  for (const helper of omit) delete openai[helper];
  const window = new Surface();
  window.openai = openai;
  window.parent = {
    postMessage(message) {
      if (message.method === 'ui/initialize' && message.id !== undefined) {
        queueMicrotask(() => window.dispatchEvent({ type: 'message', source: window.parent, data: {
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2026-01-26', hostInfo: { name: 'mock host', version: '1.0.0' }, hostCapabilities: {} },
        } }));
      }
      if (message.method === 'tools/call' && message.id !== undefined) {
        const { name, arguments: args } = message.params;
        calls.tools.push({ name, args: clone(args) }); calls.events.push(`rpc-tool:${name}`);
        assert.equal(name, 'get_job', 'RPC fallback must never take a second screenshot');
        Promise.resolve().then(() => callTool ? callTool(name, args) : completed(args.job_id))
          .then(result => window.dispatchEvent({ type: 'message', source: window.parent,
            data: { jsonrpc: '2.0', id: message.id, result } }))
          .catch(error => window.dispatchEvent({ type: 'message', source: window.parent,
            data: { jsonrpc: '2.0', id: message.id, error: { message: error.message } } }));
      }
    },
  };
  window.location = new URL('https://widget.example.invalid/screenshot');
  window.document = document;
  const setTimeoutMock = (callback, delay = 0, ...args) => {
    const id = ++timerId;
    timers.set(id, { callback, delay, due: clock + Number(delay), args });
    return id;
  };
  const clearTimeoutMock = id => timers.delete(id);
  const urlShim = class extends URL {
    static createObjectURL() { return 'blob:mock-preview-only'; }
    static revokeObjectURL() {}
  };
  Object.assign(window, {
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    URL: urlShim,
    File, Blob, atob, btoa,
  });
  const context = vm.createContext({
    window, document, location: window.location,
    navigator: { userAgent: 'WidgetTest/1.0' },
    console, File, Blob, URL: urlShim, Uint8Array, ArrayBuffer,
    atob, btoa, TextEncoder, TextDecoder,
    setTimeout: setTimeoutMock, clearTimeout: clearTimeoutMock,
    requestAnimationFrame: callback => setTimeoutMock(callback, 0),
    CustomEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
  });
  const setGlobals = envelope => {
    openai.toolOutput = envelope?.structuredContent;
    openai.toolResponseMetadata = envelope ? {
      status: 'success', call_tool_result: envelope, mcp_tool_result: envelope,
    } : null;
  };
  if (initial) setGlobals(initial);
  for (const [index, script] of scripts.entries()) {
    vm.runInContext(script, context, { filename: `${widgetUrl.pathname}:inline-${index + 1}`, timeout: 1000 });
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const result = {
    calls, openai, elements, timers,
    async notify(envelope, source = window.parent) {
      window.dispatchEvent({
        type: 'message', source,
        data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: envelope },
      });
      await settle();
    },
    async globals(envelope) {
      setGlobals(envelope);
      window.dispatchEvent({ type: 'openai:set_globals', detail: { globals: {
        toolOutput: openai.toolOutput, toolResponseMetadata: openai.toolResponseMetadata,
      } } });
      await settle();
    },
    async tick(count = 1) {
      for (let i = 0; i < count; i++) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        clock = timer.due;
        timer.callback(...timer.args);
        await settle();
      }
    },
    async retry() {
      const button = allElements.find(element => element.tagName === 'BUTTON'
        && (/retry/i.test(element.id) || /retry|try again/i.test(element.textContent)));
      assert.ok(button, 'A real Retry button must exist');
      button.click();
      await settle();
    },
    visibleText() {
      return allElements.filter(element => !element.hidden)
        .map(element => `${element.textContent} ${element.innerHTML}`).join('\n');
    },
    settle,
  };
  await settle();
  return result;
}

function assertNoAttachment(host) {
  assert.equal(host.calls.followUp.length, 0);
  assert.equal(host.calls.states.some(state => Array.isArray(state.imageIds) && state.imageIds.length), false,
    'No failed path may claim a file attachment or invent a file ID');
  assert.match(host.visibleText(), /not attached|no (?:image )?attach(?:ment|ed)|could not attach|cannot attach|unable to attach/i);
}

async function assertAttached(host, envelope = completed(), fileId = genuineId) {
  assert.equal(host.calls.upload.length, 1);
  const file = host.calls.upload[0].file;
  assert.ok(file instanceof File, 'uploadFile must receive a native File');
  const expectedImage = envelope._meta?.screenshot ?? envelope.content.find(item => item.type === 'image');
  assert.equal(file.type, expectedImage.mimeType);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(expectedImage.data, 'base64'),
    'Exact tool image bytes must be uploaded');
  const state = host.calls.states.findLast(value => Array.isArray(value.imageIds) && value.imageIds.includes(fileId));
  assert.ok(state, 'The actual host-returned file ID must reach widget imageIds');
  assert.deepEqual(state.imageIds, [fileId]);
  const modelContent = typeof state.modelContent === 'string' ? state.modelContent : JSON.stringify(state.modelContent);
  for (const value of [envelope.structuredContent.job_id, envelope.structuredContent.result.screenshot_id,
    'mimeType', expectedImage.mimeType, 'width', 'height', 'offsetX', '-1920', 'offsetY', '40',
    'scale', '0.5', 'sourceWidth', 'sourceHeight', 'coordinates', 'window_id', 'window-test']) {
    assert.ok(modelContent.includes(value), `modelContent must preserve screenshot metadata: ${value}`);
  }
  assert.equal(host.calls.followUp.length, 1);
  assert.equal(typeof host.calls.followUp[0].prompt, 'string');
  assert.ok(host.calls.followUp[0].prompt.length);
  assert.ok(host.calls.events.indexOf('state') < host.calls.events.indexOf('follow-up'),
    'Persist imageIds before asking for a same-chat follow-up');
  assert.equal(host.calls.tools.some(call => call.name !== 'get_job'), false);
}

test('full MCP lifecycle envelope becomes a native File, genuine image ID, then same-chat follow-up', async () => {
  const host = await boot();
  await host.notify(completed());
  await assertAttached(host);
});

test('initial window.openai globals include full canonical result and preserve its image', async () => {
  const host = await boot({ initial: completed() });
  await assertAttached(host);
});

test('JPEG screenshot image retains its binary bytes and MIME type through upload', async () => {
  const host = await boot();
  const envelope = completed();
  // Transport bytes are deliberately distinct from the PNG fixture; validation
  // here is of lossless base64 transport, not image-decoder correctness.
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  envelope.structuredContent.result.image.mimeType = 'image/jpeg';
  envelope.content = [
    { type: 'text', text: JSON.stringify(envelope.structuredContent) },
    { type: 'image', data: jpegBytes.toString('base64'), mimeType: 'image/jpeg' },
  ];
  await host.notify(envelope);
  await assertAttached(host, envelope);
});

test('late window.openai globals can deliver the canonical result', async () => {
  const host = await boot();
  await host.globals(completed());
  await assertAttached(host);
});

test('widget-only screenshot bytes in tool metadata are uploaded without altering metadata', async () => {
  const host = await boot();
  const envelope = completed();
  envelope._meta = { screenshot: envelope.content.find(item => item.type === 'image') };
  envelope.content = envelope.content.filter(item => item.type !== 'image');
  await host.notify(envelope);
  await assertAttached(host, envelope);
});

test('text JSON plus image content remains usable when structuredContent is absent', async () => {
  const host = await boot();
  const envelope = completed();
  delete envelope.structuredContent;
  await host.notify(envelope);
  await assertAttached(host);
});

test('duplicate results while upload is in flight do not upload or follow up twice', async () => {
  let finishUpload;
  const host = await boot({ upload: () => new Promise(resolve => { finishUpload = resolve; }) });
  await host.notify(completed());
  await host.notify(completed());
  await host.globals(completed());
  assert.equal(host.calls.upload.length, 1);
  finishUpload({ fileId: genuineId });
  await host.settle();
  await host.notify(completed());
  await host.retry();
  await assertAttached(host);
});

test('pending screenshot polls get_job through running to done without another screenshot', async () => {
  let poll = 0;
  const host = await boot({ initial: pending(), callTool: async (_name, args) => {
    assert.equal(args.job_id, 'job-widget-test');
    return ++poll === 1 ? pending('running') : completed();
  } });
  await host.tick(6);
  assert.equal(poll, 2);
  assert.deepEqual(host.calls.tools.map(call => call.name), ['get_job', 'get_job']);
  await assertAttached(host);
});

test('failed pending-job polling reports no attachment and never resubmits screenshot', async () => {
  const host = await boot({ initial: pending(), callTool: async () => {
    throw new Error('mock get_job network failure');
  } });
  await host.tick(1);
  assert.equal(host.calls.upload.length, 0);
  assert.equal(host.calls.tools.length, 1);
  assertNoAttachment(host);
});

test('MCP Apps RPC fallback polls only the existing job when callTool helper is absent', async () => {
  const host = await boot({ initial: pending(), omit: ['callTool'] });
  await host.tick(2);
  assert.deepEqual(host.calls.tools, [{ name: 'get_job', args: { job_id: 'job-widget-test' } }]);
  await assertAttached(host);
});

test('tool notifications from unrelated windows cannot attach a screenshot', async () => {
  const host = await boot();
  await host.notify(completed(), { unrelated: true });
  assert.equal(host.calls.upload.length, 0);
  assert.equal(host.calls.followUp.length, 0);
});

test('metadata without image pixels explicitly reports no attachment', async () => {
  const host = await boot();
  const envelope = completed();
  envelope.content = envelope.content.filter(item => item.type !== 'image');
  await host.notify(envelope);
  assert.equal(host.calls.upload.length, 0);
  assertNoAttachment(host);
});

for (const helper of ['uploadFile', 'setWidgetState']) {
  test(`missing host ${helper} explicitly reports no attachment and invents no ID`, async () => {
    const host = await boot({ omit: [helper] });
    await host.notify(completed());
    assert.equal(host.calls.upload.length, 0, 'Detect all required host helpers before uploading');
    assertNoAttachment(host);
  });
}

test('missing follow-up helper truthfully offers a manual chat message with the genuine attachment', async () => {
  const host = await boot({ omit: ['sendFollowUpMessage'] });
  await host.notify(completed());
  assert.equal(host.calls.upload.length, 1);
  assert.deepEqual(host.calls.states.findLast(state => state.imageIds?.length).imageIds, [genuineId]);
  assert.equal(host.calls.followUp.length, 0);
  assert.match(host.visibleText(), /send a (?:chat )?message/i);
});

test('failed upload explicitly reports no attachment and can be retried with the real returned ID', async () => {
  let attempt = 0;
  const host = await boot({ upload: async () => {
    if (++attempt === 1) throw new Error('mock host upload rejected');
    return { fileId: genuineId };
  } });
  await host.notify(completed());
  assertNoAttachment(host);
  await host.retry();
  assert.equal(host.calls.upload.length, 2);
  assert.deepEqual(host.calls.states.findLast(state => state.imageIds?.length).imageIds, [genuineId]);
  assert.equal(host.calls.followUp.length, 1);
});

for (const returned of [{}, { fileId: '' }, null]) {
  test(`upload response ${JSON.stringify(returned)} cannot fabricate an attachment ID`, async () => {
    const host = await boot({ upload: async () => returned });
    await host.notify(completed());
    assertNoAttachment(host);
  });
}

test('state failure after upload retries with saved host file ID and does not reupload', async () => {
  let attempt = 0;
  const host = await boot({ persist: () => { if (++attempt === 1) throw new Error('mock state rejected'); } });
  await host.notify(completed());
  assert.equal(host.calls.upload.length, 1);
  assert.equal(host.calls.followUp.length, 0);
  await host.retry();
  await assertAttached(host);
});

test('follow-up failure can retry sending without uploading an already attached image again', async () => {
  let attempt = 0;
  const host = await boot({ followUp: async () => {
    if (++attempt === 1) throw new Error('mock follow-up rejected');
  } });
  await host.notify(completed());
  assert.equal(host.calls.upload.length, 1);
  assert.equal(host.calls.followUp.length, 1);
  await host.retry();
  assert.equal(host.calls.upload.length, 1);
  assert.equal(host.calls.followUp.length, 2);
  assert.deepEqual(host.calls.states.findLast(state => state.imageIds?.length).imageIds, [genuineId]);
});

test('a distinct completed job receives its own genuine host file ID', async () => {
  let next = 0;
  const host = await boot({ upload: async () => ({ fileId: `file_mock-host-${++next}` }) });
  await host.notify(completed('job-first'));
  await host.notify(completed('job-second'));
  assert.equal(host.calls.upload.length, 2);
  assert.equal(host.calls.followUp.length, 2);
  assert.deepEqual([...new Set(host.calls.states.flatMap(state => state.imageIds ?? []))],
    ['file_mock-host-1', 'file_mock-host-2']);
});

test('remount preserves a previously attached job and sent follow-up without another upload', async () => {
  const host = await boot({ initial: completed(), savedState: {
    modelContent: { job_id: 'job-widget-test' },
    privateContent: { job_id: 'job-widget-test', fileId: genuineId, followupSent: true },
    imageIds: [genuineId],
  } });
  assert.equal(host.calls.upload.length, 0);
  assert.equal(host.calls.followUp.length, 0);
  assert.deepEqual(host.calls.states.findLast(state => state.imageIds?.length).imageIds, [genuineId]);
});
