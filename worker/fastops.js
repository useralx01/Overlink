const ALLOWED = new Set(['status', 'health', 'list', 'read', 'project']);
const PROJECT_READS = new Set(['project_status', 'git_diff', 'language_status', 'lsp_symbols', 'lsp_definition']);
const MAX_BATCH = 8;
const throwInput = message => { throw Object.assign(new Error(message), { status: 400 }); };

export async function inspectBatch(env, account, entries, enqueue) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_BATCH)
    throwInput('batch_inspect expects between one and eight inspections');
  const checked = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throwInput('Invalid inspection');
    if (!ALLOWED.has(entry.operation)) throwInput('Only read-only PC inspections are supported');
    if (typeof entry.device_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(entry.device_id))
      throwInput('Invalid device identifier');
    const args = entry.args === undefined ? {} : entry.args;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 12)
      throwInput('Inspection args must be a small object');
    for (const key of Object.keys(args))
      if (['request_id','device_id','computer_id','approved','allowJavaScript','root'].includes(key))
        throwInput('Reserved inspection argument');
    if (entry.operation === 'project' && !PROJECT_READS.has(args.action))
      throwInput('Only read-only project inspection actions are allowed');
    if (entry.operation === 'read' && (typeof args.path !== 'string' || !args.path))
      throwInput('Read inspection requires a path');
    if (entry.operation === 'list' && args.path !== undefined && typeof args.path !== 'string')
      throwInput('Invalid list path');
    return { index, operation: entry.operation, device_id: entry.device_id, args };
  });
  const responses = await Promise.all(checked.map(async item => {
    try {
      const response = await enqueue(env, account, item.operation,
        { ...item.args, device_id: item.device_id });
      return { index: item.index, operation: item.operation, device_id: item.device_id, ...response };
    } catch (error) {
      return { index: item.index, operation: item.operation, device_id: item.device_id,
        status: 'error', error: error.message || 'Inspection unavailable' };
    }
  }));
  return { items: responses, count: responses.length };
}

export async function pollBatch(env, account, ids, resultFn) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 ||
      ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36,64}$/i.test(id)))
    throwInput('poll_jobs expects one to ten valid job identifiers');
  const jobs = await Promise.all(ids.map(async job_id => {
    try { return await resultFn(env, account, job_id, 0); }
    catch (error) { return { job_id, status: 'error', error: error.message }; }
  }));
  return { jobs };
}

export function aggregateMetrics(rows) {
  const values = new Map();
  for (const row of rows) {
    if (!row || typeof row.operation !== 'string') continue;
    const start = Number(row.created), completed = Number(row.completed);
    const latency = completed - start;
    if (!Number.isFinite(latency) || latency < 0 || latency > 3_600_000) continue;
    if (!values.has(row.operation)) values.set(row.operation, []);
    values.get(row.operation).push(latency);
  }
  const operations = [...values].map(([operation, latencies]) => {
    latencies.sort((a,b) => a-b);
    const percentile = p => latencies[Math.max(0,Math.ceil(latencies.length*p)-1)];
    return { operation, count: latencies.length,
      p50_ms: percentile(.5), p95_ms: percentile(.95),
      mean_ms: Math.round(latencies.reduce((sum,x)=>sum+x,0)/latencies.length),
      max_ms:latencies[latencies.length-1] };
  });
  return { operations: operations.sort((a,b)=>b.count-a.count),
    scope: 'completed relay jobs, recent 7 days (maximum 200 samples)',
    note: 'Includes queueing and processing; excludes time spent thinking in the model' };
}

export async function jobMetrics(env, account) {
  const rows = await env.DB.prepare(
    'SELECT operation,created,completed FROM jobs WHERE owner=? AND completed>? AND completed IS NOT NULL ORDER BY completed DESC LIMIT 200'
  ).bind(account, Date.now()-7*24*3600_000).all();
  return aggregateMetrics(rows.results || []);
}

export const performanceTools = [
  {
    name:'batch_inspect',
    description:'Perform 1–8 independent READ-ONLY device inspections in parallel in one MCP tool call. entries: [{device_id,operation:"status"|"health"|"list"|"read"|"project", args?}]. For project only read-only actions are accepted. Responses may contain pending job IDs; use poll_jobs without resubmitting.',
    inputSchema:{ type:'object', additionalProperties:false,
      properties:{entries:{type:'array',minItems:1,maxItems:8,items:{type:'object'}}},required:['entries'] },
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  },
  {
    name:'poll_jobs', description:'Check up to 10 previously queued job IDs concurrently. Never resubmit a mutation while pending.',
    inputSchema:{type:'object',additionalProperties:false,properties:{job_ids:{type:'array',minItems:1,maxItems:10,items:{type:'string'}}},required:['job_ids']},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  },
  {
    name:'performance_metrics', description:'Get p50/p95/mean relay latency statistics by operation from recent completed jobs, without exposing logs or command content.',
    inputSchema:{type:'object',additionalProperties:false,properties:{}},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  }
];
