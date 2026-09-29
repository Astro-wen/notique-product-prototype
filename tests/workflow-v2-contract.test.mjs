import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowRequest as parse, WorkflowValidationError } from "../lib/shared/workflow-v2.ts";
import { buildRecordText, priorityCards, recordCounts, selectSourceRanges } from "../lib/domain/workflow-v2.ts";

const base = { expectedContextVersion: 4 };
const version = { claimId: "budget", claimVersionId: "budget-v1" };
const decision = { ...base, expectedCardRevision: 1, operation: "confirm", members: [{ ...version, operation: "confirm" }] };
const outcome = { ...base, expectedActionRevision: 1, text: "联系了供应商，暂时没有报价", evidenceRefs: [], resolveQuestions: [], completeAction: true };
const fail = (name, input, field) => assert.throws(() => parse(name, input), (error) => error instanceof WorkflowValidationError && (!field || error.field === field));

test("wire requests reject unknown authority fields and malformed versions", () => {
  fail("DecisionRequest", { ...decision, actorId: "another-user" }, "request.actorId");
  for (const bad of [null, "4", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) fail("DecisionRequest", { ...decision, expectedContextVersion: bad }, "expectedContextVersion");
  assert.deepEqual(parse("DecisionRequest", decision), decision);
});

test("edits require an explicit origin and source corrections require evidence", () => {
  const edit = { ...decision, operation: "edit", members: [{ ...version, operation: "edit", newText: "  大约三十五万元  ", origin: "user_input", evidenceRefIds: [] }] };
  assert.equal(parse("DecisionRequest", edit).members[0].newText, "大约三十五万元");
  fail("DecisionRequest", { ...edit, members: [{ ...edit.members[0], origin: undefined }] });
  fail("DecisionRequest", { ...edit, members: [{ ...edit.members[0], origin: "source_statement" }] });
  fail("DecisionRequest", { ...decision, members: [{ ...version, operation: "accept_action" }] });
  fail("DecisionRequest", { ...decision, members: [decision.members[0], decision.members[0]] }, "members");
});

test("defer preserves a nullable manual-resume date and rejects invalid calendar dates", () => {
  const request = { ...decision, operation: "defer", members: [{ ...version, operation: "defer" }] };
  assert.equal(parse("DecisionRequest", request).deferUntil, null);
  assert.equal(parse("DecisionRequest", { ...request, deferUntil: "2026-10-01T09:00:00+08:00" }).deferUntil, "2026-10-01T01:00:00.000Z");
  for (const date of ["2026-10-01", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z"]) fail("DecisionRequest", { ...request, deferUntil: date }, "deferUntil");
  fail("DecisionRequest", { ...decision, deferUntil: null }, "deferUntil");
});

test("completing an action never manufactures an answer", () => {
  assert.deepEqual(parse("OutcomeRequest", outcome).resolveQuestions, []);
  assert.deepEqual(parse("ActionTransitionRequest", { ...base, expectedActionRevision: 1, operation: "complete" }), { ...base, expectedActionRevision: 1, operation: "complete" });
  fail("OutcomeRequest", { ...outcome, text: "", resolveQuestions: [{ questionId: "fee", revision: 1, answerText: "" }] });
  fail("OutcomeRequest", { ...outcome, completeAction: "true" }, "completeAction");
});

test("an answer can be saved directly with no action, preserving old-answer choices", () => {
  const request = { ...base, expectedQuestionRevision: 1, answerText: "十二万元", evidenceRefs: [] };
  assert.equal(parse("QuestionAnswerRequest", request).answerText, "十二万元");
  const choice = { mode: "coexist", priorAnswerRefs: [version], applicability: "原报价仅含硬装，新报价包含软装" };
  assert.deepEqual(parse("QuestionAnswerRequest", { ...request, answerDecision: choice }).answerDecision, choice);
  fail("QuestionAnswerRequest", { ...request, answerDecision: { ...choice, applicability: "" } });
  fail("QuestionAnswerRequest", { ...request, answerDecision: { ...choice, priorAnswerRefs: [] } });
});

test("one result cannot silently resolve unrelated or duplicate questions", () => {
  const answered = { ...outcome, resolveQuestions: [{ questionId: "fee", revision: 2, answerText: "十二万元" }] };
  fail("OutcomeRequest", { ...answered, resolveQuestions: [...answered.resolveQuestions, ...answered.resolveQuestions] });
  fail("OutcomeRequest", { ...answered, answerDecisions: [{ questionId: "timing", mode: "replace", priorAnswerRefs: [version] }] }, "answerDecisions");
});

test("corrections and withdrawals are distinct, versioned commands", () => {
  const withdrawal = { ...base, expectedOutcomeRevision: 2, operation: "withdraw" };
  assert.deepEqual(parse("OutcomeCorrectionRequest", withdrawal), withdrawal);
  fail("OutcomeCorrectionRequest", { ...withdrawal, replacement: {} });
  fail("OutcomeCorrectionRequest", { ...withdrawal, operation: "replace" });
});

test("zero-review export requires an explicit mixed scope and preserves all readable content", () => {
  fail("ReportRequest", { ...base, eventIds: [], format: "plain_text" }, "scope");
  assert.equal(parse("ReportRequest", { ...base, eventIds: [], scope: "mixed", format: "plain_text" }).scope, "mixed");
  const bullets = [
    { id: "budget", text: "预算大约三十万元", reviewState: "accepted", origin: "source_statement", sourceStatus: "ready", claimRefs: [version] },
    { id: "time", text: "搬入时间尚未确定", reviewState: "draft", origin: "source_statement", sourceStatus: "ready", claimRefs: [{ claimId: "time", claimVersionId: "time-v1" }] },
  ];
  const input = { title: "沟通记录", bullets, questions: [], coverage: { complete: true, totalSegments: 2, completedSegments: 2, unprocessedRanges: [] }, scope: "mixed", format: "plain_text" };
  assert.match(buildRecordText(input), /大约三十万元.*已采纳/);
  assert.match(buildRecordText(input), /搬入时间尚未确定.*AI 草稿/);
  assert.doesNotMatch(buildRecordText({ ...input, scope: "accepted" }), /搬入/);
  assert.doesNotMatch(buildRecordText({ ...input, bullets: [{ ...bullets[0], sourceStatus: "missing" }] }), /三十万元/);
});

test("priority counts reflect important decisions, not all drafts", () => {
  const card = (id, needsDecision, disposition, reasonCode) => ({ id, needsDecision, disposition, reasonCode });
  const cards = [card("ordinary", false, "active", null), card("later", true, "deferred", "action_choice"), card("action", true, "active", "action_choice"), card("changed", true, "active", "accepted_change")];
  assert.deepEqual(priorityCards(cards).map((c) => c.id), ["changed", "action"]);
  assert.deepEqual(recordCounts([{ reviewState: "draft" }, { reviewState: "draft" }, { reviewState: "accepted" }], cards, [{ executionState: "completed" }]), { draftCount: 2, needsDecisionCount: 2, openActionCount: 0 });
});

test("source selection uses exact immutable text, canonicalizes order, and protects character boundaries", () => {
  const source = [{ id: "s1", assetVersionId: "av1", ordinal: 0, textRaw: "预算大约三十万" }, { id: "s2", assetVersionId: "av1", ordinal: 1, textRaw: "周末🏡看房" }];
  const input = { ...base, assetVersionId: "av1", ranges: [{ segmentId: "s1", startOffset: 2, endOffset: 7 }, { segmentId: "s1", startOffset: 0, endOffset: 2 }] };
  assert.deepEqual(selectSourceRanges(input, source), { quote: "预算大约三十万", segmentIds: ["s1"], ranges: [{ segmentId: "s1", startOffset: 0, endOffset: 7 }] });
  for (const ranges of [
    [{ segmentId: "s2", startOffset: 3, endOffset: 5 }],
    [{ segmentId: "s1", startOffset: 0, endOffset: 200 }],
    [{ segmentId: "unknown", startOffset: 0, endOffset: 1 }],
  ]) assert.throws(() => selectSourceRanges({ ...input, ranges }, source), WorkflowValidationError);
  assert.throws(() => selectSourceRanges({ ...input, assetVersionId: "old" }, source), WorkflowValidationError);
  fail("SourceHighlightRequest", { ...input, ranges: [...input.ranges, input.ranges[0]] }, "ranges");
});

test("pagination has a bounded size and cannot jump between snapshots", () => {
  assert.deepEqual(parse("WorkspaceQuery", {}), { limit: 20 });
  assert.deepEqual(parse("OverviewQuery", { limit: "50", minContextVersion: "4" }), { limit: 50, minContextVersion: 4 });
  fail("WorkspaceQuery", { cursor: "page2" }, "snapshotId");
  for (const limit of [0, 51, "2e1", " ", null, 1.1]) fail("WorkspaceQuery", { limit }, "limit");
});

test("analysis is explicit and retries identify failed stages rather than restarting everything", () => {
  assert.deepEqual(parse("StartAnalysisRequest", { sourceRevision: 2, mode: "reorganize" }), { sourceRevision: 2, mode: "reorganize" });
  fail("RetryAnalysisRequest", { expectedRunRevision: 1, stageIds: [] });
  fail("RetryAnalysisRequest", { expectedRunRevision: 1, stageIds: ["one", "one"] });
  assert.deepEqual(parse("ReviewProgressRequest", { snapshotId: "snap", lastCardId: null, mode: "finish_session" }), { snapshotId: "snap", lastCardId: null, mode: "finish_session" });
});

test('a saved answer replaces its unanswered wording in the same record and exported text', async () => {
  const {currentRecordBullets}=await import('../lib/domain/workflow-v2.ts');
  const bullet=(id,text,state='draft')=>({id,text,claimRefs:[{claimId:id,claimVersionId:id+'_v'}],reviewState:state,origin:state==='accepted'?'user_input':'source_statement',sourceStatus:'ready'});
  const bullets=[bullet('budget','预算三十万'),bullet('question','费用尚未确定'),bullet('action','询价'),bullet('answer','报价十二万','accepted')];
  const questions=[{id:'question',claimRef:{claimId:'question',claimVersionId:'question_v'},resolutionState:'resolved',answerRefs:[{claimId:'answer',claimVersionId:'answer_v'}]}];
  assert.deepEqual(currentRecordBullets(bullets,questions).map(b=>b.id),['budget','answer','action']);
  const text=buildRecordText({title:'记录',bullets,questions,scope:'mixed',format:'plain_text',coverage:{complete:true}});
  assert.doesNotMatch(text,/尚未确定/);
  assert.equal(text.split('报价十二万').length-1,1);
  assert.equal(recordCounts(bullets,[],[],questions).draftCount,2);
});

test('question correction choices are exact version references with no implicit answer acceptance',()=>{
  const request={...decision,operation:'edit',members:[{...version,operation:'edit',newText:'含税费用是多少？',origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:[{claimId:'answer',claimVersionId:'answer-v1',mode:'keep'}]}}]};
  assert.deepEqual(parse('DecisionRequest',request),request);
  for(const choice of [{claimId:'answer',claimVersionId:'answer-v1',mode:''},{claimId:'answer',claimVersionId:'answer-v1',mode:'keep',actorId:'fake'}])fail('DecisionRequest',{...request,members:[{...request.members[0],questionChange:{answerChoices:[choice]}}]});
  fail('DecisionRequest',{...request,members:[{...request.members[0],questionChange:{answerChoices:[request.members[0].questionChange.answerChoices[0],request.members[0].questionChange.answerChoices[0]]}}]});
  fail('DecisionRequest',{...decision,members:[{...version,operation:'confirm',questionChange:{answerChoices:[]}}]});
});
