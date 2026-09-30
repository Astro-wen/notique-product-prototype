import assert from 'node:assert/strict';
import test from 'node:test';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {workflowDatabase, seed, insert, SCOPE, T} from './helpers/workflow-database.mjs';
import {readMcpTool} from '../lib/server/mcp/readers.ts';
import {handleMcpRequest} from '../lib/server/mcp/server.ts';
import {setMcpConnection} from '../lib/server/mcp/access.ts';
import {WorkflowFault} from '../lib/server/workflow/snapshot-store.ts';

const ENV = {APP_ENV: 'local', AUTH_GATEWAY: 'chatgpt', INTERNAL_WORKSPACE_ID: 'ws'};
const IDENTITY = {workspaceId: 'ws', actorId: 'owner@example.com', gatewaySubject: 'synthetic-sites-user'};
const omitted = '第二场培训参加人数尚未确定';
async function setup(t) {
  const fixture = await workflowDatabase();
  t.after(fixture.close);
  seed(fixture.sqlite);
  fixture.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
  return fixture;
}
function warnings(sqlite, statements = [omitted], flags = []) {
  sqlite.prepare("UPDATE extraction_runs SET status='completed_with_warnings',error_details_json=? WHERE id='run'")
    .run(JSON.stringify({warnings: [
      ...statements.map(statement => ({code: 'MODEL_CANDIDATE_OMITTED', statement, reason: 'private diagnostic'})),
      ...flags.map(code => code === 'MODEL_SUPPORTED_FOLLOWUP_OMITTED'
        ? {code, inventory_keys: ['synthetic-omission']}
        : {code, limit: 64, observed: 64}),
      {code: 'PROVIDER_INTERNAL', statement: 'private provider body'},
    ]}));
}
function summary(sqlite) {
  const sentenceRefs = [
    {text: '预算大约三十万。', claimRefs: [{claimId: 'budget', claimVersionId: 'budget_v1'}], reviewState: 'draft'},
    {text: '费用待定。', claimRefs: [{claimId: 'question', claimVersionId: 'question_v1'}], reviewState: 'draft'},
  ];
  insert(sqlite, 'workflow_narratives', {
    id: 'summary', workspace_id: 'ws', project_id: 'p', event_id: 'e', scope_key: 'e', scope_kind: 'mixed',
    based_on_context_version: 0, text: sentenceRefs.map(row => row.text).join(' '),
    sentence_refs_json: JSON.stringify(sentenceRefs), freshness: 'current', input_hash: 'summary', created_at: T,
  });
}
const changeCount = sqlite => sqlite.prepare('SELECT total_changes() n').get().n;
const businessState = sqlite => Object.fromEntries([
  'claims', 'claim_versions', 'claim_relations', 'workflow_outbox', 'extraction_runs', 'extraction_model_stages',
  'event_ai_artifact_runs', 'workflow_snapshots', 'verdicts', 'workflow_outcomes', 'outcome_versions',
  'action_metadata', 'workflow_narratives',
].map(table => [table, sqlite.prepare(`SELECT * FROM ${table}`).all()]));

test('MCP separates complete source coverage from known omissions without writing', async t => {
  const {db, sqlite} = await setup(t);
  warnings(sqlite, [omitted], ['MODEL_FINAL_CLAIM_LIMIT_REACHED', 'MODEL_SUPPORTED_FOLLOWUP_OMITTED']);
  const before = changeCount(sqlite);
  const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e'});
  assert.equal(reply.coverage.complete, true);
  assert.deepEqual(reply.qualityFlags, {inventoryLimitReached: false, finalClaimLimitReached: true, followUpOmitted: true});
  assert.equal(reply.omittedCandidateCount, 1);
  assert.equal(reply.qualityNotes, undefined);
  assert.equal(reply.omittedStatements, undefined);
  const row = reply.items.find(item => item.kind === 'omitted_candidate');
  assert.deepEqual(row, {
    view: 'record', kind: 'omitted_candidate', id: 'omitted_candidate:run:0', eventId: 'e', analysisRunId: 'run',
    retentionState: 'not_retained', text: omitted, claimRefs: [], evidenceRefIds: [],
  });
  assert.equal(row.reviewState, undefined);
  assert.equal(JSON.stringify(reply).includes('private'), false);
  assert.equal(changeCount(sqlite), before);
});

test('summary-only exposes a bounded count even when all three quality flags are false', async t => {
  const {db, sqlite} = await setup(t);
  warnings(sqlite);
  summary(sqlite);
  const before = changeCount(sqlite);
  const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', views: ['summary']});
  assert.deepEqual(reply.qualityFlags, {inventoryLimitReached: false, finalClaimLimitReached: false, followUpOmitted: false});
  assert.equal(reply.omittedCandidateCount, 1);
  assert.equal(reply.items.length, 2);
  assert.ok(reply.items.every(row => row.view === 'summary'));
  assert.equal(JSON.stringify(reply).includes(omitted), false);
  assert.equal(changeCount(sqlite), before);
});

test('capacity-only quality notes expose flags with a zero omitted count', async t => {
  const {db, sqlite} = await setup(t);
  warnings(sqlite, [], ['MODEL_INVENTORY_LIMIT_REACHED', 'MODEL_FINAL_CLAIM_LIMIT_REACHED']);
  const before = changeCount(sqlite);
  const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', views: ['summary']});
  assert.deepEqual(reply.qualityFlags, {inventoryLimitReached: true, finalClaimLimitReached: true, followUpOmitted: false});
  assert.equal(reply.omittedCandidateCount, 0);
  assert.ok(reply.items.every(row => row.kind !== 'omitted_candidate'));
  assert.equal(changeCount(sqlite), before);
});

test('omission bodies are bounded paged entries, including reconstructable escaped JSON fragments', async t => {
  const {db, sqlite} = await setup(t);
  const statements = Array.from({length: 201}, (_, index) => `未保留候选 ${index}`);
  warnings(sqlite, statements);
  let cursor;
  const retained = [];
  const before = changeCount(sqlite);
  do {
    const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', limit: 50, cursor});
    const {items, ...metadata} = reply;
    assert.equal(reply.omittedCandidateCount, 200);
    assert.ok(JSON.stringify(metadata).length < 2000);
    assert.ok(JSON.stringify(items).length <= 24002);
    retained.push(...items.filter(row => row.kind === 'omitted_candidate').map(row => row.text));
    cursor = reply.nextCursor;
  } while (cursor);
  assert.deepEqual(retained, statements.slice(0, 200));
  assert.equal(changeCount(sqlite), before);

  // JSON escaping makes this 8,000-character source statement exceed one
  // transport entry, exercising the real boundedEntries fragment path.
  const long = '\u0000'.repeat(7998) + '😀';
  warnings(sqlite, [long]);
  const fragments = [];
  const longBefore = changeCount(sqlite);
  do {
    const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', limit: 50, cursor});
    assert.equal(reply.omittedCandidateCount, 1);
    assert.ok(JSON.stringify(reply.items).length <= 24002);
    for (const row of reply.items.filter(row => row.kind === 'omitted_candidate')) {
      assert.equal(row.format, 'json_fragment');
      assert.equal(row.fragmentOf, 'entry');
      assert.ok(!/[\uD800-\uDBFF]$/.test(row.content));
      fragments.push(row);
    }
    cursor = reply.nextCursor;
  } while (cursor);
  assert.ok(fragments.length > 1);
  assert.equal(fragments.length, fragments[0].partCount);
  const restored = JSON.parse(fragments.toSorted((a, b) => a.partIndex - b.partIndex).map(row => row.content).join(''));
  assert.equal(restored.text, long);
  assert.equal(restored.retentionState, 'not_retained');
  assert.equal(restored.reviewState, undefined);
  assert.deepEqual(restored.claimRefs, []);
  assert.deepEqual(restored.evidenceRefIds, []);
  assert.equal(changeCount(sqlite), longBefore);
});

test('record and summary cursors expire on changes to omission bodies, counts or flags', async t => {
  const {db, sqlite} = await setup(t);
  summary(sqlite);
  for (const views of [['record'], ['summary']]) {
    for (const next of [
      {statements: ['修正后的遗漏正文'], flags: []},
      {statements: [omitted, '另一个遗漏'], flags: []},
      {statements: [omitted], flags: ['MODEL_INVENTORY_LIMIT_REACHED']},
    ]) {
      warnings(sqlite);
      const first = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', views, limit: 1});
      assert.ok(first.nextCursor);
      warnings(sqlite, next.statements, next.flags);
      const before = changeCount(sqlite);
      await assert.rejects(readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', views, limit: 1, cursor: first.nextCursor}), error => error.code === 'cursor_expired');
      assert.equal(changeCount(sqlite), before);
    }
  }
});

test('invalid current materials and tracked or legacy source revision changes hide prior omission bodies', async t => {
  for (const params of [{}, {workflow_source_revision: 0}]) {
    for (const mutate of [
      sqlite => sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run(),
      sqlite => sqlite.prepare("UPDATE events SET source_revision=1 WHERE id='e'").run(),
    ]) {
      const {db, sqlite} = await setup(t);
      warnings(sqlite);
      sqlite.prepare("UPDATE extraction_runs SET model_params_json=? WHERE id='run'").run(JSON.stringify(params));
      assert.equal((await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e'})).omittedCandidateCount, 1);
      mutate(sqlite);
      const before = changeCount(sqlite);
      for (const views of [['record'], ['summary']]) {
        const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', views});
        assert.equal(reply.qualityFlags, undefined);
        assert.equal(reply.omittedCandidateCount, undefined);
        assert.equal(JSON.stringify(reply).includes(omitted), false);
      }
      assert.equal(changeCount(sqlite), before);
    }
  }
});

test('missing historical active runs preserve authorized views without swallowing other failures', async t => {
  const {db, sqlite} = await setup(t);
  warnings(sqlite);
  summary(sqlite);
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();
  sqlite.prepare("UPDATE events SET active_run_id='removed-run' WHERE id='e'").run();
  const before = changeCount(sqlite);
  const reply = await readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e', views: ['record', 'summary']});
  assert.ok(reply.items.some(row => row.id === 'budget' && row.text === '预算大约三十万'));
  assert.ok(reply.items.some(row => row.view === 'summary' && row.text === '预算大约三十万。'));
  assert.equal(reply.qualityFlags, undefined);
  assert.equal(JSON.stringify(reply).includes(omitted), false);
  assert.equal(changeCount(sqlite), before);
  const prepare = db.prepare;
  db.prepare = sql => {
    if (sql.startsWith('SELECT r.*')) throw new WorkflowFault(503, 'temporarily_unavailable', 'synthetic read failure');
    return prepare(sql);
  };
  await assert.rejects(readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e'}), error => error.code === 'temporarily_unavailable');
});

test('unauthorized or revoked readers cannot retrieve omission text', async t => {
  const {db, sqlite} = await setup(t);
  warnings(sqlite);
  for (const scope of [{...SCOPE, workspaceId: 'foreign'}, {...SCOPE, actorId: 'stranger'}]) {
    const before = changeCount(sqlite);
    await assert.rejects(readMcpTool(db, scope, 'get_record_views', {record_id: 'e'}), error => error.code === 'not_found');
    assert.equal(changeCount(sqlite), before);
  }
  sqlite.prepare("UPDATE workspace_members SET revoked_at=? WHERE actor_id='owner'").run(T);
  const before = changeCount(sqlite);
  await assert.rejects(readMcpTool(db, SCOPE, 'get_record_views', {record_id: 'e'}), error => error.code === 'not_found');
  assert.equal(changeCount(sqlite), before);
});

test('official MCP client reads flags and paged omitted candidates through the existing six tools', async t => {
  const {db, sqlite} = await setup(t);
  warnings(sqlite);
  summary(sqlite);
  sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();
  await setMcpConnection(db, IDENTITY, ENV, true);
  const before = businessState(sqlite);
  const client = new Client({name: 'synthetic-quality-client', version: '1.0'});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {fetch: async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('oai-authenticated-user-email', IDENTITY.actorId);
    request.headers.set('oai-authenticated-user-id', IDENTITY.gatewaySubject);
    return handleMcpRequest(request, db, ENV);
  }}));
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  assert.match(tools.tools.find(tool => tool.name === 'get_record_views').description, /coverage仅表示原文范围处理，不代表业务信息完整召回/);
  const overview = await client.callTool({name: 'get_record_views', arguments: {record_id: 'e', views: ['summary']}});
  assert.equal(overview.isError, undefined);
  assert.equal(overview.structuredContent.omittedCandidateCount, 1);
  assert.equal(JSON.stringify(overview).includes(omitted), false);
  let cursor;
  const candidates = [];
  do {
    const result = await client.callTool({name: 'get_record_views', arguments: {record_id: 'e', views: ['record'], limit: 1, ...(cursor ? {cursor} : {})}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.omittedCandidateCount, 1);
    candidates.push(...result.structuredContent.items.filter(row => row.kind === 'omitted_candidate'));
    cursor = result.structuredContent.nextCursor;
  } while (cursor);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, omitted);
  assert.equal(candidates[0].retentionState, 'not_retained');
  assert.deepEqual(businessState(sqlite), before);
  await setMcpConnection(db, IDENTITY, ENV, false);
  await assert.rejects(client.callTool({name: 'get_record_views', arguments: {record_id: 'e'}}));
});
