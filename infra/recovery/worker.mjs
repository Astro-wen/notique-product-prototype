const ENDPOINT = 'https://notique-evidence-workspace.uclae2e12.chatgpt.site/api/internal/jobs/sweep';
const QUEUES = ['extraction', 'event_ai_artifacts', 'workflow'];
const COUNTS = ['claimed', 'sent', 'deferred', 'recovered', 'succeeded', 'pending', 'failed', 'obsolete', 'lostLease'];
const MAX_RESPONSE_BYTES = 262144;
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function counts(result) {
  const total = Object.fromEntries(COUNTS.map(key => [key, safeCount(result?.[key])]));
  for (const group of ['dispatch', 'transcription_dispatch']) {
    for (const key of COUNTS) total[key] += safeCount(result?.[group]?.[key]);
  }
  for (const group of ['sweep', 'transcription_sweep']) {
    for (const key of ['recoveredOutbox', 'requeuedExpiredRuns', 'requeuedLongRunningMessages']) total.recovered += safeCount(result?.[group]?.[key]);
    for (const key of ['deadLetteredOutbox', 'failedExpiredRuns', 'failedUndeliverableRuns', 'deadLetteredExhaustedPending', 'failedChunkedParents']) total.failed += safeCount(result?.[group]?.[key]);
  }
  return total;
}

async function readResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('response_limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {await reader.cancel(); throw new Error('response_limit');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** A minute tick resumes durable submitted work. It never starts a new model run. */
export async function recover(env, {send = fetch, log = console.log, timeout = AbortSignal.timeout} = {}) {
  const token = env.WORKFLOW_RECOVERY_TOKEN?.trim();
  if (!token) {log('notique_recovery', {state: 'unconfigured'}); return;}
  const signal = timeout(55000);
  try {
    const response = await send(ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: {'Authorization': 'Bearer ' + token, 'User-Agent': 'Notique-Recovery/1.0', 'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: '{}',
    });
    if (!response.ok) {log('notique_recovery', {state: 'http_failed', status: response.status}); return;}
    const body = await readResponse(response);
    const queues = body?.data?.queues;
    if (!queues || QUEUES.some(name => !['succeeded', 'failed'].includes(queues[name]?.state))) {
      log('notique_recovery', {state: 'invalid_response', status: response.status}); return;
    }
    const summary = Object.fromEntries(QUEUES.map(name => [name, {state: queues[name].state, ...counts(queues[name].result)}]));
    log('notique_recovery', {state: QUEUES.every(name => queues[name].state === 'succeeded') ? 'succeeded' : 'queue_failed', queues: summary});
  } catch {
    log('notique_recovery', {state: signal.aborted ? 'pending' : 'request_failed'});
  }
}

export default {
  fetch() {return new Response(null, {status: 404});},
  scheduled(_controller, env, ctx) {ctx.waitUntil(recover(env));},
};
