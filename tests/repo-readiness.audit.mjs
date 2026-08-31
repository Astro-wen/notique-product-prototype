import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { declarationSource, uiSource } from "./helpers/ui-source.mjs";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

async function exists(relativePath) {
  try {
    await stat(new URL(relativePath, root));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function collectFiles(relativeDirectory) {
  const directory = new URL(relativeDirectory, root);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${relativeDirectory.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

test("production UI does not ship hard-coded AI claims or browser-only verdict state", async () => {
  const appFiles = (await collectFiles("app")).filter((path) => /\.(ts|tsx|js|jsx)$/.test(path));
  const source = (await Promise.all(appFiles.map(read))).join("\n");

  assert.doesNotMatch(source, /const\s+claimSets\s*[:=]/);
  assert.doesNotMatch(source, /quote:\s*["'`]/);
  assert.doesNotMatch(source, /time:\s*["'`]\d{1,2}:\d{2}/);
  assert.doesNotMatch(source, /MODEL_NOT_CONFIGURED[\s\S]{0,500}(sample|mock|fallback)/i);
});

test("Cloudflare persistence bindings are declared", async () => {
  const hosting = JSON.parse(await read(".openai/hosting.json"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, "EVIDENCE");
});

test("database schema is real and includes the deterministic P0 records", async () => {
  const schema = await read("db/schema.ts");
  for (const table of [
    "projects",
    "events",
    "assets",
    "assetVersions",
    "textSegments",
    "extractionRuns",
    "extractionModelStages",
    "claims",
    "claimVersions",
    "evidenceRefs",
    "verdicts",
    "claimRelations",
    "queueOutbox",
  ]) {
    assert.match(schema, new RegExp(`\\b${table}\\b`), `missing ${table}`);
  }
});

test("two-pass model stages are resumable, bounded, and safely exposed", async () => {
  const repository = await read("lib/server/db/extraction-stage-repository.ts");
  const core = await read("lib/server/db/core-repository.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const stageContract = await read("lib/server/jobs/model-stage-contract.ts");
  const provider = await read("lib/server/ai/model-provider.ts");
  const migration = await read("drizzle/0010_extraction_model_stages.sql");

  assert.match(migration, /UNIQUE INDEX `uq_extraction_model_stages_run_stage_attempt`/);
  assert.match(migration, /FOREIGN KEY \(`run_id`\) REFERENCES `extraction_runs`\(`id`\)[\s\S]{0,100}ON DELETE cascade/i);
  assert.match(repository, /MAX_VALIDATED_OUTPUT_BYTES\s*=\s*1024\s*\*\s*1024/);
  assert.match(
    repository,
    /assertImmutableMatch[\s\S]{0,1000}reasoning_effort[\s\S]{0,500}input_hash/,
    "stage reuse must guard all frozen model and input parameters",
  );
  assert.match(
    repository,
    /WHERE extraction_model_stages\.status <> 'succeeded'/,
    "a paid succeeded stage must never be overwritten by a processing resume",
  );
  assert.match(
    repository,
    /SENSITIVE_DEBUG_KEYS[\s\S]{0,500}["']authorization["'][\s\S]{0,500}["']r2_original_key["']/,
    "stage debug output must redact credentials and private object keys",
  );
  assert.match(core, /listExtractionModelStageDebug\(runId, scope\.workspaceId\)/);
  assert.match(core, /stages,/);
  assert.match(
    processor,
    /existing\?\.status === ["']succeeded["'][\s\S]{0,500}reused:\s*true/,
    "a successful paid stage must be reused on the same Run",
  );
  assert.match(
    processor,
    /canReuseSucceededModelStage\(existing, frozenInput\)/,
    "succeeded output may be reused only after the processor checks its exact frozen input",
  );
  assert.match(
    processor,
    /canResumeProcessingModelStage\(existing, frozenInput\)/,
    "processing resume and succeeded reuse must share the same frozen-input contract",
  );
  for (const field of [
    "provider",
    "model",
    "reasoning_effort",
    "prompt_version",
    "schema_version",
    "input_hash",
  ]) {
    assert.match(stageContract, new RegExp(`persisted\\.${field}`));
  }
  assert.doesNotMatch(
    provider,
    /server excludes every readable segment marked requiresAttention/i,
    "Agent B prompt v9 must not silently acquire new filtered-readable wording",
  );
  assert.match(
    processor,
    /MODEL_ESCALATION_OUTPUT_INVALID[\s\S]{0,250}fallback_stage:\s*["']verify["']/,
    "an invalid optional escalation must fall back to the already valid verification output",
  );
  assert.match(
    processor,
    /persistedExtractionUsage\(String\(run\.id\)\)[\s\S]{0,220}completedUsage \?\?[\s\S]{0,180}error instanceof ModelOutputInvalidError/,
    "all persisted paid stage attempts must remain in aggregate usage accounting",
  );
  assert.match(
    provider,
    /relation target must copy an exact claim_id and claim_version_id[\s\S]{0,180}never invent a target ID/i,
    "the verifier must forbid relation targets outside the frozen Context Pack",
  );
});

test("Run Debug persists only bounded, schema-validated model output", async () => {
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const core = await read("lib/server/db/core-repository.ts");
  const schema = await read("db/schema.ts");
  const migration = await read("drizzle/0005_cultured_fat_cobra.sql");

  assert.match(schema, /validatedOutputJson:\s*text\(["']validated_output_json["']\)/);
  assert.match(migration, /ALTER TABLE [`"]?extraction_runs[`"]? ADD [`"]?validated_output_json[`"]? text/i);
  assert.match(
    processor,
    /validateExtractClaimsOutput[\s\S]{0,1500}persistModelOutput/i,
    "provider output must pass the authoritative validator before persistence",
  );
  assert.match(
    processor,
    /MAX_VALIDATED_OUTPUT_BYTES\s*=\s*1024\s*\*\s*1024/i,
    "validated output must have a fixed 1 MiB persistence limit",
  );
  assert.match(
    processor,
    /validatedOutputBytes\s*=\s*new TextEncoder\(\)\.encode\(validatedOutputJson\)\.byteLength[\s\S]{0,500}MODEL_OUTPUT_INVALID/i,
    "validated output must have an actual UTF-8 byte limit",
  );
  assert.match(
    processor,
    /UPDATE extraction_runs[\s\S]{0,500}status\s*=\s*\?[\s\S]{0,500}validated_output_json\s*=\s*\?[\s\S]{0,900}db\.batch\(statements\)/i,
    "validated output and successful status must commit in the same D1 batch",
  );
  const failedSection = processor.slice(
    processor.indexOf("async function markRunFailed"),
    processor.indexOf("export async function processExtractionRun"),
  );
  assert.doesNotMatch(
    failedSection,
    /validated_output_json/i,
    "failed runs must not retain a model response as validated output",
  );
  assert.match(
    core,
    /validated_output:\s*parseJson\(String\(validatedOutputJson\s*\?\?\s*["']null["']\),\s*null\)/,
    "Run Debug must return parsed validated_output and null for failed or pre-model runs",
  );
  assert.match(
    core,
    /for\s*\(const key of\s*\[[\s\S]{0,500}["']idempotency_key["'][\s\S]{0,500}["']model_params_json["'][\s\S]{0,500}["']error_details_json["'][\s\S]{0,500}delete debugRow\[key\]/i,
    "Run Debug must remove replay keys and raw JSON columns before returning its parsed view",
  );
});

test("reasoning effort is frozen per Run and Run Debug exposes execution limits", async () => {
  const modelConfig = await read("lib/domain/model-config.ts");
  const core = await read("lib/server/db/core-repository.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const provider = await read("lib/server/ai/model-provider.ts");
  const page = uiSource;

  assert.doesNotMatch(modelConfig, /OPENAI_REASONING_EFFORTS\s*=\s*\[[\s\S]{0,200}["']max["']/);
  assert.match(modelConfig, /value\?\.trim\(\)\.toLowerCase\(\) \|\| ["']xhigh["']/);
  assert.match(modelConfig, /normalizeVerifierReasoningEffort[\s\S]{0,220}\|\| ["']high["']/);

  assert.match(
    core,
    /inputHash\s*=\s*await shaText[\s\S]{0,900}reasoning_effort:\s*reasoningEffort/i,
    "reasoning effort must participate in the immutable Run input hash",
  );
  assert.match(
    core,
    /modelParamsJson\s*=\s*JSON\.stringify\([\s\S]{0,500}reasoning_effort:\s*reasoningEffort/i,
    "reasoning effort must be persisted in model_params_json",
  );
  assert.match(
    core,
    /inputHash\s*=\s*await shaText[\s\S]{0,1200}max_output_tokens:\s*maxOutputTokens[\s\S]{0,200}timeout_ms:\s*timeoutMs/i,
    "frozen output and timeout limits must participate in the immutable Run input hash",
  );
  assert.match(
    core,
    /modelParamsJson\s*=\s*JSON\.stringify\([\s\S]{0,500}max_output_tokens:\s*maxOutputTokens[\s\S]{0,200}timeout_ms:\s*timeoutMs/i,
    "output and timeout limits must be persisted in model_params_json",
  );
  assert.match(
    processor,
    /const\s+inventoryEffort\s*=[\s\S]{0,250}frozenModelParams\.reasoning_effort/i,
    "the inventory stage must read the Run's frozen reasoning effort",
  );
  assert.match(
    processor,
    /reasoningEffort:\s*inventoryEffort/i,
    "the inventory provider must receive the frozen reasoning effort",
  );
  assert.match(
    processor,
    /const\s+verifierEffort\s*=\s*normalizeVerifierReasoningEffort[\s\S]{0,250}frozenModelParams\.verifier_reasoning_effort/i,
    "the verification stage must read the Run's frozen verifier effort",
  );
  assert.match(
    processor,
    /reasoningEffort:\s*verifierEffort/i,
    "the verification provider must receive the frozen verifier effort",
  );
  assert.match(
    processor,
    /maxOutputTokens\s*=[\s\S]{0,200}max_output_tokens[\s\S]{0,300}timeoutMs\s*=[\s\S]{0,200}timeout_ms[\s\S]{0,1200}createModelProvider/i,
    "the processor must pass the Run's frozen output and timeout limits to the provider",
  );
  assert.match(
    provider,
    /endpoint\s*=\s*isOpenAi\s*\?\s*["']responses["'][\s\S]{0,500}reasoning:\s*\{\s*effort:\s*this\.reasoningEffort\s*\}/i,
    "OpenAI Responses requests must receive the frozen reasoning effort",
  );
  for (const field of ["reasoning_effort", "max_output_tokens", "timeout_ms"]) {
    assert.match(page, new RegExp(`\\b${field}\\b`), `Run Debug must expose ${field}`);
  }
  assert.match(
    page,
    /没有完整冻结执行参数/,
    "Run Debug must warn instead of silently substituting current environment values",
  );
});

test("a real v1 API route exists and does not embed mock extraction output", async () => {
  const routePath = "app/api/v1/[...segments]/route.ts";
  assert.equal(await exists(routePath), true, `${routePath} is missing`);
  const route = await read(routePath);
  assert.doesNotMatch(route, /mock|sample claim|fallback claim/i);
  assert.match(route, /request[_-]?id/i);
  assert.match(route, /idempotency/i);
});

test("the declared API contract contains required deterministic error codes", async () => {
  const contract = await read("lib/shared/api-types.ts");
  for (const code of [
    "TOO_MANY_IMAGES",
    "IMAGE_CONVERSION_FAILED",
    "MODEL_PROVIDER_NOT_CONFIGURED",
    "MODEL_TIMEOUT",
    "MODEL_OUTPUT_INVALID",
    "EVIDENCE_VALIDATION_FAILED",
    "RUN_BUDGET_EXCEEDED",
    "WORKSPACE_RUN_LIMIT",
    "SCENARIO_CONFIRMATION_REQUIRED",
    "SCENARIO_VERSION_CONFLICT",
    "QUEUE_DISPATCH_DELAYED",
    "CLAIM_VERSION_CONFLICT",
    "CLAIM_STATE_CONFLICT",
    "IDEMPOTENCY_KEY_REQUIRED",
    "PROJECT_SCOPE_VIOLATION",
  ]) {
    assert.match(contract, new RegExp(`\\b${code}\\b`), `missing ${code}`);
  }
});

test("repository enforces input-hash idempotency, scenario state CAS, and canonical claim types", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const verdicts = await read("lib/server/db/verdict-repository.ts");

  assert.match(
    core,
    /existing[\s\S]{0,500}input_hash[\s\S]{0,500}inputHash[\s\S]{0,500}(IDEMPOTENCY|conflict|CONFLICT)/i,
    "same idempotency key with a different input_hash must fail instead of replaying",
  );
  assert.match(
    core,
    /WHERE[\s\S]{0,300}scenario_status\s*=\s*'pending_confirmation'[\s\S]{0,300}scenario_version\s*=\s*\?/i,
    "scenario confirmation must CAS both pending_confirmation state and scenario_version",
  );
  assert.doesNotMatch(
    `${core}\n${verdicts}`,
    /lower\(c?\.?type\)\s*=\s*'open question'/i,
    "Open Question uses the canonical open_question enum value",
  );
  assert.match(
    core,
    /scenario_status[\s\S]{0,300}sequence_no[\s\S]{0,300}SCENARIO_CONFIRMATION_REQUIRED/i,
    "later events must wait for scenario confirmation",
  );
});

test("all four resource-creation APIs require durable request-hash idempotency", async () => {
  const route = await read("app/api/v1/[...segments]/route.ts");
  const core = await read("lib/server/db/core-repository.ts");
  const replay = await read("lib/server/db/mutation-replay.ts");
  const functions = [
    ["createProject", "export async function listProjects"],
    ["createEvent", "export async function listEvents"],
    ["createTranscriptImport", "export async function getTranscriptImport"],
    ["initializeAsset", "function maxAssetBytes"],
  ];

  for (const [name, next] of functions) {
    const section = core.slice(
      core.indexOf(`export async function ${name}`),
      core.indexOf(next, core.indexOf(`export async function ${name}`)),
    );
    assert.match(section, /findMutationReplay/,
      `${name} must look up the persisted replay before mutating`);
    assert.match(section, /mutationReplayStatement/,
      `${name} must commit its replay record with the resource`);
    assert.match(section, /catch[\s\S]*?findMutationReplay/,
      `${name} must recover the winning response after a concurrent insert`);
  }
  for (const call of ["createProject", "createEvent", "createTranscriptImport", "initializeAsset"]) {
    assert.match(
      route,
      new RegExp(`${call}\\([\\s\\S]{0,900}idempotencyKey\\(request\\)`, "i"),
      `${call} route must reject a missing Idempotency-Key before calling its repository`,
    );
  }
  assert.match(
    replay,
    /row\.request_hash\s*!==\s*hash[\s\S]*?409[\s\S]*?IDEMPOTENCY_CONFLICT/i,
    "the same key with a different canonical body hash must return 409",
  );
  assert.match(
    replay,
    /row\.request_hash[\s\S]*?response:\s*parseJson/i,
    "the same key with the same body hash must replay the stored response",
  );
});

test("transcript finalization and extraction retries are race-safe", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const createImport = core.slice(
    core.indexOf("export async function createTranscriptImport"),
    core.indexOf("export async function getTranscriptImport"),
  );
  const finalizeImport = core.slice(
    core.indexOf("export async function finalizeTranscriptImport"),
    core.indexOf("export async function initializeAsset"),
  );
  const uploadImportItem = core.slice(
    core.indexOf("export async function uploadTranscriptImportItem"),
    core.indexOf("function transcriptFormat"),
  );
  const extraction = core.slice(
    core.indexOf("export async function createExtractionRun"),
    core.indexOf("export async function getExtractionRun"),
  );

  assert.doesNotMatch(
    createImport,
    /mutation_guards|prepared\.length/,
    "the finalize-only CAS guard must not make a newly-created import fail",
  );
  assert.match(
    finalizeImport,
    /mutation_guards[\s\S]{0,800}status\s*=\s*'open'[\s\S]{0,800}upload_status\s*=\s*'uploaded'/i,
    "finalize must atomically guard an open import whose complete item set is uploaded",
  );
  assert.match(
    uploadImportItem,
    /UPDATE transcript_import_items[\s\S]*?upload_status\s*=\s*'uploaded'[\s\S]*?WHERE[\s\S]*?upload_status\s*=\s*'pending'[\s\S]*?EXISTS\s*\([\s\S]*?transcript_imports[\s\S]*?status\s*=\s*'open'[\s\S]*?expires_at\s*>\s*\?/i,
    "an item upload must CAS pending -> uploaded while its parent import is still open and unexpired",
  );
  assert.match(
    uploadImportItem,
    /meta\.changes[\s\S]*?SELECT item\.upload_status[\s\S]*?content_sha256[\s\S]*?IDEMPOTENCY_CONFLICT/i,
    "an upload that loses its CAS must reread the winner and either replay identical content or reject it",
  );
  assert.match(
    uploadImportItem,
    /upload_status\s*===\s*["']uploaded["']\s*\|\|\s*row\.upload_status\s*===\s*["']finalized["']/i,
    "an identical network retry may replay after finalize without changing the item back to uploaded",
  );
  assert.match(
    uploadImportItem,
    /current\?\.upload_status\s*===\s*["']uploaded["']\s*\|\|\s*current\?\.upload_status\s*===\s*["']finalized["']/i,
    "a concurrent finalize that wins after R2 upload must still replay identical bytes",
  );
  assert.doesNotMatch(
    uploadImportItem,
    /WHERE[^;`]*upload_status\s*=\s*'finalized'[^;`]*SET[^;`]*upload_status\s*=\s*'uploaded'/i,
    "the upload endpoint must never regress a finalized item",
  );
  assert.match(
    uploadImportItem,
    /SELECT 1 AS referenced[\s\S]*?asset_versions[\s\S]*?getEvidenceBucket\(\)\.delete\(key\)/i,
    "a losing upload may delete only an R2 key that is not referenced by an import item or Asset Version",
  );
  assert.match(
    extraction,
    /catch[\s\S]{0,800}SELECT \* FROM extraction_runs[\s\S]{0,800}input_hash[\s\S]{0,800}IDEMPOTENCY_CONFLICT/i,
    "an extraction insert race must recover a same-input run and reject a different input",
  );
});

test("Asset abort is scoped, idempotent, cleans staged storage, and fences upload/finalize races", async () => {
  const [core, route, schema, workflow] = await Promise.all([
    read("lib/server/db/core-repository.ts"),
    read("app/api/v1/[...segments]/route.ts"),
    read("db/schema.ts"),
    read("lib/server/db/workflow-repository.ts"),
  ]);
  const upload = core.slice(
    core.indexOf("export async function uploadAssetContent"),
    core.indexOf("export async function abandonAssetUpload"),
  );
  const abort = core.slice(
    core.indexOf("export async function abandonAssetUpload"),
    core.indexOf("export async function finalizeAsset"),
  );
  const finalize = core.slice(
    core.indexOf("export async function finalizeAsset"),
    core.indexOf("export async function getAsset"),
  );
  const readiness = core.slice(
    core.indexOf("function eventMaterialReadinessStatement"),
    core.indexOf("export async function initializeAsset"),
  );

  assert.match(route, /abandonAssetUpload/);
  assert.match(
    route,
    /segments\[0\] === ["']assets["'][\s\S]{0,100}segments\[2\] === ["']abort["'][\s\S]{0,140}abandonAssetUpload\(scope, segments\[1\]\)/,
    "POST /assets/:id/abort must call the scoped repository operation",
  );
  assert.doesNotMatch(
    schema.slice(schema.indexOf("export const mutationReplays"), schema.indexOf("export const projects")),
    /assetId|asset_id|assets\.id/,
    "retaining a terminal Asset must keep init mutation replay references resolvable",
  );
  assert.match(
    upload,
    /processing_status = 'uploading' AND staged_r2_key IS NULL/,
    "content upload must CAS only from uploading",
  );
  assert.match(upload, /getEvidenceBucket\(\)\.delete\(key\)/);
  assert.doesNotMatch(upload, /current\?\.staged_r2_key === key \|\| current\?\.current_version_id/);
  assert.match(
    upload,
    /processing_status\) === "parsing"[\s\S]{0,180}staged_r2_key === key[\s\S]{0,100}staged_sha256 === sha[\s\S]{0,120}return getAsset/,
    "only an identical parsing winner may replay a concurrent content PUT",
  );
  assert.match(
    upload,
    /current\?\.current_version_id[\s\S]{0,220}SELECT r2_original_key FROM asset_versions[\s\S]{0,200}owner\?\.r2_original_key === key[\s\S]{0,220}getEvidenceBucket\(\)\.delete\(key\)/,
    "a late PUT after finalize may keep only the exact object owned by the immutable version",
  );
  assert.match(
    upload,
    /processing_status\) === "failed"[\s\S]{0,500}SET staged_r2_key = \?, staged_sha256 = \?[\s\S]{0,600}SET staged_r2_key = NULL/,
    "a late PUT after abort must delete its object or leave durable cleanup work",
  );
  assert.match(
    abort,
    /workspace_id = \?[\s\S]{0,120}current_version_id IS NULL[\s\S]{0,120}processing_status IN \('uploading', 'parsing'\)/,
  );
  assert.match(abort, /processing_status = 'failed', failure_code = 'UPLOAD_ABORTED'/);
  assert.match(
    abort,
    /if \(current\.current_version_id\) return getAsset\(scope, assetId\);[\s\S]{0,500}recomputeEventMaterialReadiness\(scope, String\(current\.event_id\)\)[\s\S]{0,260}getEvidenceBucket\(\)\.delete\(stagedKey\)/,
    "abort must reread the winner before deleting staged storage",
  );
  assert.match(
    abort,
    /processing_status = 'failed' AND staged_r2_key = \?/,
    "only the same terminal staged key may be cleared after R2 deletion",
  );
  assert.match(
    finalize,
    /INSERT INTO mutation_guards[\s\S]{0,500}processing_status = 'parsing'[\s\S]{0,180}staged_r2_key = \? AND staged_sha256 = \?/,
    "finalize must atomically guard the exact parsing payload",
  );
  assert.match(
    finalize,
    /UPDATE assets[\s\S]{0,280}processing_status = 'parsing'[\s\S]{0,160}staged_r2_key = \? AND staged_sha256 = \?/,
    "finalize may publish only the exact still-active staged payload",
  );
  assert.match(
    readiness,
    /material_status = CASE[\s\S]{0,180}material_status = 'archived'[\s\S]{0,1200}processing_status <> 'ready'/,
    "a cancelled tombstone must not block a later successful Asset from making its Event ready",
  );
  assert.match(readiness, /analysis_source'[\s\S]*artifact_kind'[\s\S]*transcription_chunk'/);
  assert.match(finalize, /eventMaterialReadinessStatement\(scope, String\(row\.event_id\), timestamp\)/);
  assert.match(
    workflow,
    /WITH material_counts AS \([\s\S]{0,500}COALESCE\(failure_code, ''\) NOT IN \('UPLOAD_ABORTED', 'UPLOAD_EXPIRED'\)/,
    "cancelled tombstones must not appear as failed or processing workflow material",
  );
  assert.match(
    core.slice(core.indexOf("export async function getEvent"), core.indexOf("export async function createTranscriptImport")),
    /COALESCE\(a\.failure_code, ''\) NOT IN \('UPLOAD_ABORTED', 'UPLOAD_EXPIRED'\)/,
    "cancelled tombstones must not reappear as user-visible Event material",
  );
});

test("Asset abort SQL prevents zombie processing rows under D1/SQLite race ordering", async () => {
  const [core, workflow] = await Promise.all([
    read("lib/server/db/core-repository.ts"),
    read("lib/server/db/workflow-repository.ts"),
  ]);
  const upload = core.slice(
    core.indexOf("export async function uploadAssetContent"),
    core.indexOf("export async function abandonAssetUpload"),
  );
  const abort = core.slice(
    core.indexOf("export async function abandonAssetUpload"),
    core.indexOf("export async function finalizeAsset"),
  );
  const finalize = core.slice(
    core.indexOf("export async function finalizeAsset"),
    core.indexOf("export async function getAsset"),
  );
  const readiness = core.slice(
    core.indexOf("function eventMaterialReadinessStatement"),
    core.indexOf("export async function initializeAsset"),
  );
  const sql = (section, expression, label) => {
    const match = section.match(expression);
    assert.ok(match, `${label} SQL was not found in the repository`);
    return match[1];
  };
  const uploadCasSql = sql(
    upload,
    /`(UPDATE assets[^`]*?processing_status = 'uploading' AND staged_r2_key IS NULL)`/,
    "upload CAS",
  );
  const abortCasSql = sql(
    abort,
    /`(UPDATE assets\s+SET processing_status = 'failed'[^`]*?processing_status IN \('uploading', 'parsing'\))`/,
    "abort CAS",
  );
  const cleanupSql = sql(
    abort,
    /`(UPDATE assets\s+SET staged_r2_key = NULL[^`]*?processing_status = 'failed' AND staged_r2_key = \?)`/,
    "abort cleanup",
  );
  const finalizeGuardSql = sql(
    finalize,
    /`(INSERT INTO mutation_guards[^`]*?staged_r2_key = \? AND staged_sha256 = \?[^`]*?END, \?)`/,
    "finalize guard",
  );
  const finalizeCasSql = sql(
    finalize,
    /`(UPDATE assets\s+SET current_version_id = \?[^`]*?staged_r2_key = \? AND staged_sha256 = \?)`/,
    "finalize CAS",
  );
  const eventReadySql = sql(
    readiness,
    /`(UPDATE events\s+SET material_status = CASE[^`]*?WHERE id = \? AND workspace_id = \?)`/,
    "Event material readiness update",
  );
  const materialCountsSql = sql(
    workflow,
    /WITH material_counts AS \(\s*([\s\S]*?GROUP BY event_id)\s*\)\s*SELECT/,
    "workflow material counts",
  );

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE mutation_guards (
        id TEXT PRIMARY KEY,
        guard_value INTEGER NOT NULL CHECK (guard_value = 1),
        created_at TEXT NOT NULL
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        current_version_id TEXT,
        staged_r2_key TEXT,
        staged_sha256 TEXT,
        staged_mime_type TEXT,
        staged_size_bytes INTEGER,
        failure_code TEXT,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        material_status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE asset_versions (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        r2_original_key TEXT NOT NULL
      );
      INSERT INTO events VALUES ('event-a', 'ws-a', 'draft', 't0');
      INSERT INTO assets VALUES
        ('uploading', 'ws-a', 'event-a', 'uploading', NULL, NULL, NULL, 'text/plain', 3, NULL, '{}', 't0'),
        ('staged', 'ws-a', 'event-a', 'parsing', NULL, 'r2/staged', 'sha-staged', 'text/plain', 3, NULL, '{}', 't0'),
        ('wrong-scope', 'ws-b', 'event-b', 'uploading', NULL, NULL, NULL, 'text/plain', 3, NULL, '{}', 't0'),
        ('ready', 'ws-a', 'event-a', 'ready', 'av-ready', 'r2/ready', 'sha-ready', 'text/plain', 3, NULL, '{}', 't0'),
        ('finalize-live', 'ws-a', 'event-a', 'parsing', NULL, 'r2/live', 'sha-live', 'text/plain', 3, NULL, '{}', 't0');
      INSERT INTO asset_versions VALUES ('av-ready', 'ready', 'r2/ready');
    `);

    const abortCas = database.prepare(abortCasSql);
    const uploadCas = database.prepare(uploadCasSql);
    const cleanup = database.prepare(cleanupSql);

    assert.equal(abortCas.run("t1", "uploading", "ws-a").changes, 1);
    assert.equal(
      uploadCas.run("r2/late", "sha-late", "text/plain", 3, "t2", "uploading", "ws-a").changes,
      0,
      "a content request that reaches D1 after abort must not advance to parsing",
    );
    assert.deepEqual(
      { ...database.prepare("SELECT processing_status, failure_code FROM assets WHERE id = 'uploading'").get() },
      { processing_status: "failed", failure_code: "UPLOAD_ABORTED" },
    );
    assert.equal(abortCas.run("t3", "uploading", "ws-a").changes, 0, "abort must be idempotent");

    assert.equal(abortCas.run("t1", "staged", "ws-a").changes, 1);
    const stagedKey = database.prepare("SELECT staged_r2_key FROM assets WHERE id = 'staged'").get().staged_r2_key;
    assert.equal(stagedKey, "r2/staged", "the key stays durable until object deletion succeeds");
    const storedObjects = new Set([stagedKey]);
    storedObjects.delete(stagedKey);
    assert.equal(cleanup.run("t2", "staged", "ws-a", stagedKey).changes, 1);
    assert.equal(storedObjects.size, 0);
    assert.equal(database.prepare("SELECT staged_r2_key FROM assets WHERE id = 'staged'").get().staged_r2_key, null);

    assert.equal(abortCas.run("t1", "wrong-scope", "ws-a").changes, 0);
    assert.equal(
      database.prepare("SELECT processing_status FROM assets WHERE id = 'wrong-scope'").get().processing_status,
      "uploading",
    );
    assert.equal(abortCas.run("t1", "ready", "ws-a").changes, 0);
    assert.deepEqual(
      { ...database.prepare("SELECT processing_status, current_version_id, staged_r2_key FROM assets WHERE id = 'ready'").get() },
      { processing_status: "ready", current_version_id: "av-ready", staged_r2_key: "r2/ready" },
      "abort must not mutate or delete finalized content",
    );

    assert.throws(() => {
      database.exec("BEGIN");
      try {
        database.prepare(finalizeGuardSql).run(
          "guard-aborted", "staged", "ws-a", "r2/staged", "sha-staged", "t4",
        );
        database.prepare("INSERT INTO asset_versions VALUES (?, ?, ?)").run(
          "av-should-not-exist", "staged", "r2/staged",
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }, /CHECK constraint failed/);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM asset_versions WHERE id = 'av-should-not-exist'").get().count,
      0,
      "an abort winner must make the whole finalize batch roll back",
    );

    database.exec("BEGIN");
    database.prepare(finalizeGuardSql).run(
      "guard-live", "finalize-live", "ws-a", "r2/live", "sha-live", "t5",
    );
    database.prepare("INSERT INTO asset_versions VALUES (?, ?, ?)").run(
      "av-live", "finalize-live", "r2/live",
    );
    assert.equal(
      database.prepare(finalizeCasSql).run(
        "av-live", "t5", "finalize-live", "ws-a", "r2/live", "sha-live",
      ).changes,
      1,
    );
    database.prepare(eventReadySql).run(
      "event-a", "ws-a", "event-a", "ws-a", "t5", "event-a", "ws-a",
    );
    database.prepare("DELETE FROM mutation_guards WHERE id = ?").run("guard-live");
    database.exec("COMMIT");
    assert.equal(abortCas.run("t6", "finalize-live", "ws-a").changes, 0);
    assert.deepEqual(
      { ...database.prepare("SELECT processing_status, current_version_id FROM assets WHERE id = 'finalize-live'").get() },
      { processing_status: "ready", current_version_id: "av-live" },
      "a finalize winner must remain immutable under a later abort",
    );
    assert.equal(
      database.prepare("SELECT material_status FROM events WHERE id = 'event-a'").get().material_status,
      "ready",
      "old UPLOAD_ABORTED rows must not block a successful re-upload from making the Event ready",
    );
    const counts = database.prepare(materialCountsSql).get("ws-a");
    assert.deepEqual(
      { ...counts },
      {
        event_id: "event-a",
        material_total: 2,
        material_ready: 2,
        material_processing: 0,
        material_failed: 0,
      },
      "workflow material counts must contain only the two successful Assets",
    );
  } finally {
    database.close();
  }
});

test("Event material readiness is recomputed from live user sources", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const readiness = core.slice(
    core.indexOf("function eventMaterialReadinessStatement"),
    core.indexOf("export async function initializeAsset"),
  );
  const match = readiness.match(
    /`(UPDATE events\s+SET material_status = CASE[^`]*?WHERE id = \? AND workspace_id = \?)`/,
  );
  assert.ok(match, "Event material readiness SQL was not found");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        material_status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        failure_code TEXT,
        metadata_json TEXT NOT NULL
      );
      INSERT INTO events VALUES
        ('event-a', 'ws-a', 'draft', 't0'),
        ('event-b', 'ws-a', 'ready', 't0'),
        ('event-archived', 'ws-a', 'archived', 't0'),
        ('event-other', 'ws-b', 'ready', 't0');
      INSERT INTO assets VALUES
        ('ready-a', 'ws-a', 'event-a', 'ready', NULL, '{}'),
        ('parsing-b', 'ws-a', 'event-a', 'parsing', NULL, '{}'),
        ('internal', 'ws-a', 'event-a', 'parsing', NULL, '{"analysis_source":false}'),
        ('readable', 'ws-a', 'event-a', 'parsing', NULL, '{"artifact_kind":"readable_transcript"}'),
        ('chunk', 'ws-a', 'event-a', 'parsing', NULL, '{"transcription_chunk":true}'),
        ('internal-only', 'ws-a', 'event-b', 'ready', NULL, '{"analysis_source":false}'),
        ('archived-ready', 'ws-a', 'event-archived', 'ready', NULL, '{}'),
        ('other-ready', 'ws-b', 'event-other', 'ready', NULL, '{}');
    `);
    const recompute = database.prepare(match[1]);
    const run = (eventId, workspaceId = "ws-a") => recompute.run(
      eventId,
      workspaceId,
      eventId,
      workspaceId,
      "t1",
      eventId,
      workspaceId,
    );

    run("event-a");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-a'").get().material_status, "draft");
    database.prepare("UPDATE assets SET processing_status='failed', failure_code='UPLOAD_ABORTED' WHERE id='parsing-b'").run();
    run("event-a");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-a'").get().material_status, "ready");
    database.prepare("INSERT INTO assets VALUES ('new-user-upload', 'ws-a', 'event-a', 'uploading', NULL, '{}')").run();
    run("event-a");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-a'").get().material_status, "draft");

    run("event-b");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-b'").get().material_status, "draft");
    run("event-archived");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-archived'").get().material_status, "archived");
    run("event-other", "ws-a");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-other'").get().material_status, "ready");
  } finally {
    database.close();
  }
});

test("the durable repair creates extraction for every uncovered current source manifest", async () => {
  const [automatic, outbox, worker] = await Promise.all([
    read("lib/server/jobs/automatic-extraction.ts"),
    read("lib/server/jobs/outbox.ts"),
    read("worker/index.ts"),
  ]);
  const candidateMatch = automatic.match(
    /const candidates = await all\(\s*`([^`]+)`/,
  );
  assert.ok(candidateMatch, "automatic extraction candidate SQL was not found");
  assert.match(automatic, /WITH current_sources AS/);
  assert.match(automatic, /a\.kind <> 'audio'/);
  assert.match(automatic, /a\.processing_status = 'ready'/);
  assert.match(automatic, /HAVING COUNT\(\*\) <= \?/);
  assert.match(automatic, /sc\.sequence_no = 1 OR sc\.scenario_status = 'confirmed'/);
  assert.match(automatic, /ORDER BY random\(\)/);
  assert.match(automatic, /source_audio_asset_version_id/);
  assert.match(automatic, /json_valid\(er\.input_manifest_json\)/);
  assert.match(automatic, /SELECT COUNT\(\*\) FROM json_each\(er\.input_manifest_json\)/);
  assert.match(automatic, /NOT EXISTS \([\s\S]*current_sources source[\s\S]*json_each\(er\.input_manifest_json\) manifest_item/);
  assert.match(automatic, /TRANSCRIPTION_NOT_READY/);
  assert.match(automatic, /MAX_EXTRACTION_ASSET_VERSIONS\s*=\s*25/);
  assert.match(automatic, /MAX_AUTOMATIC_EXTRACTION_ATTEMPTS\s*=\s*2/);
  assert.match(automatic, /COVERED_EXTRACTION_RUN_STATES = new Set\(\[[\s\S]*"completed_with_warnings"[\s\S]*"cancelled"/);
  assert.match(automatic, /er\.status IN \([\s\S]{0,180}'completed_with_warnings', 'cancelled'/);
  assert.match(automatic, /auto-manifest\.v1:\$\{digest\}/);
  assert.match(automatic, /retryOrdinal > 0 \? `\$\{base\}:retry-\$\{retryOrdinal\}`/);
  assert.match(automatic, /const exactRuns = previousRuns\.filter[\s\S]{0,300}sameIds/);
  assert.match(automatic, /failedAttempts >= MAX_AUTOMATIC_EXTRACTION_ATTEMPTS/);
  assert.match(automatic, /createExtractionRun\([\s\S]{0,300}assetVersionIds/);
  assert.match(outbox, /ensureAutomaticExtractionRuns/);
  assert.ok(
    outbox.indexOf("await ensureAutomaticExtractionRuns()") <
      outbox.indexOf("dispatchDueTranscriptionOutbox()"),
    "the durable ensure must run before the Cron dispatch pass",
  );
  assert.match(worker, /sweepAndDispatch\(\)/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        deleted_at TEXT,
        scenario_status TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        material_status TEXT NOT NULL,
        sequence_no INTEGER NOT NULL
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        current_version_id TEXT,
        processing_status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        failure_code TEXT
      );
      CREATE TABLE extraction_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_manifest_json TEXT NOT NULL
      );
      INSERT INTO projects VALUES
        ('project-a', 'ws-a', NULL, 'confirmed'),
        ('project-b', 'ws-a', NULL, 'unassessed'),
        ('project-c', 'ws-a', NULL, 'unassessed');
      INSERT INTO events VALUES
        ('event-new', 'ws-a', 'project-a', 'ready', 1),
        ('event-covered', 'ws-a', 'project-a', 'ready', 1),
        ('event-added', 'ws-a', 'project-a', 'ready', 1),
        ('event-photo', 'ws-a', 'project-a', 'ready', 1),
        ('event-transcript', 'ws-a', 'project-a', 'ready', 1),
        ('event-warning-covered', 'ws-a', 'project-a', 'ready', 1),
        ('event-cancelled-covered', 'ws-a', 'project-a', 'ready', 1),
        ('event-draft', 'ws-a', 'project-a', 'draft', 1),
        ('event-stale', 'ws-a', 'project-a', 'ready', 1),
        ('event-unassessed-first', 'ws-a', 'project-b', 'ready', 1),
        ('event-unassessed-later', 'ws-a', 'project-b', 'ready', 2),
        ('event-retry-exhausted', 'ws-a', 'project-c', 'ready', 1);
      INSERT INTO assets VALUES
        ('audio-new', 'ws-a', 'event-new', 'audio', 'audio-version-new', 'ready', '{}', NULL),
        ('derived-new', 'ws-a', 'event-new', 'transcript', 'transcript-version-new', 'ready', '{"source_audio_asset_version_id":"audio-version-new"}', NULL),
        ('audio-covered', 'ws-a', 'event-covered', 'audio', 'audio-version-covered', 'ready', '{}', NULL),
        ('derived-covered', 'ws-a', 'event-covered', 'transcript', 'transcript-version-covered', 'ready', '{"source_audio_asset_version_id":"audio-version-covered"}', NULL),
        ('transcript-added', 'ws-a', 'event-added', 'transcript', 'transcript-version-added', 'ready', '{}', NULL),
        ('photo-added', 'ws-a', 'event-added', 'photo', 'photo-version-added', 'ready', '{}', NULL),
        ('photo-only', 'ws-a', 'event-photo', 'photo', 'photo-version-only', 'ready', '{}', NULL),
        ('transcript-only', 'ws-a', 'event-transcript', 'transcript', 'transcript-version-only', 'ready', '{}', NULL),
        ('warning-covered', 'ws-a', 'event-warning-covered', 'transcript', 'transcript-version-warning', 'ready', '{}', NULL),
        ('cancelled-covered', 'ws-a', 'event-cancelled-covered', 'transcript', 'transcript-version-cancelled', 'ready', '{}', NULL),
        ('draft-transcript', 'ws-a', 'event-draft', 'transcript', 'transcript-version-draft', 'ready', '{}', NULL),
        ('audio-stale', 'ws-a', 'event-stale', 'audio', 'audio-version-current', 'ready', '{}', NULL),
        ('derived-stale', 'ws-a', 'event-stale', 'transcript', 'transcript-version-old', 'ready', '{"source_audio_asset_version_id":"audio-version-old"}', NULL),
        ('first-unassessed', 'ws-a', 'event-unassessed-first', 'transcript', 'transcript-version-first', 'ready', '{}', NULL),
        ('later-unassessed', 'ws-a', 'event-unassessed-later', 'transcript', 'transcript-version-later', 'ready', '{}', NULL),
        ('retry-exhausted', 'ws-a', 'event-retry-exhausted', 'transcript', 'transcript-version-exhausted', 'ready', '{}', NULL);
      INSERT INTO extraction_runs VALUES (
        'run-covered', 'ws-a', 'event-covered', 'succeeded',
        '[{"asset_version_id":"transcript-version-covered"}]'
      );
      INSERT INTO extraction_runs VALUES (
        'run-added-old', 'ws-a', 'event-added', 'succeeded',
        '[{"asset_version_id":"transcript-version-added"}]'
      );
      INSERT INTO extraction_runs VALUES (
        'run-first-failed', 'ws-a', 'event-unassessed-first', 'failed',
        '[{"asset_version_id":"transcript-version-first"}]'
      );
      INSERT INTO extraction_runs VALUES
        ('run-exhausted-1', 'ws-a', 'event-retry-exhausted', 'failed', '[{"asset_version_id":"transcript-version-exhausted"}]'),
        ('run-exhausted-2', 'ws-a', 'event-retry-exhausted', 'failed', '[{"asset_version_id":"transcript-version-exhausted"}]'),
        ('run-warning', 'ws-a', 'event-warning-covered', 'completed_with_warnings', '[{"asset_version_id":"transcript-version-warning"}]'),
        ('run-cancelled', 'ws-a', 'event-cancelled-covered', 'cancelled', '[{"asset_version_id":"transcript-version-cancelled"}]');
    `);
    const rows = database.prepare(candidateMatch[1]).all(25, 2, 50);
    assert.deepEqual(
      rows.map((row) => row.event_id).sort(),
      ["event-added", "event-new", "event-photo", "event-transcript", "event-unassessed-first"],
      "transcript/photo-only, expanded manifests, and a once-failed unassessed first Event are repaired; successful, warning, cancelled, exhausted, draft, stale-lineage, and blocked later Events are skipped",
    );
  } finally {
    database.close();
  }
});

test("stale Asset upload leases self-heal after a lost abort without blocking ready material", async () => {
  const [core, workflow] = await Promise.all([
    read("lib/server/db/core-repository.ts"),
    read("lib/server/db/workflow-repository.ts"),
  ]);
  const sweep = core.slice(
    core.indexOf("export async function expireStaleAssetUploads"),
    core.indexOf("export async function abandonAssetUpload"),
  );
  const heartbeat = core.slice(
    core.indexOf("export async function heartbeatAssetUpload"),
    core.indexOf("export async function expireStaleAssetUploads"),
  );
  const upload = core.slice(
    core.indexOf("export async function uploadAssetContent"),
    core.indexOf("export async function expireStaleAssetUploads"),
  );
  const readiness = core.slice(
    core.indexOf("function eventMaterialReadinessStatement"),
    core.indexOf("export async function initializeAsset"),
  );
  const sql = (section, expression, label) => {
    const match = section.match(expression);
    assert.ok(match, `${label} SQL was not found in the repository`);
    return match[1];
  };

  assert.match(core, /STALE_ASSET_UPLOAD_TTL_MS\s*=\s*15 \* 60_000/);
  assert.match(heartbeat, /workspace_id = \?/);
  assert.match(heartbeat, /current_version_id IS NULL/);
  assert.match(heartbeat, /processing_status = 'uploading'/);
  assert.match(sweep, /workspace_id = \?/);
  assert.match(sweep, /current_version_id IS NULL/);
  assert.match(sweep, /updated_at < \?/);
  assert.match(sweep, /STALE_ASSET_SWEEP_LIMIT/);
  assert.match(sweep, /failure_code = 'UPLOAD_EXPIRED'/);
  assert.match(sweep, /getEvidenceBucket\(\)\.delete\(stagedKey\)/);
  assert.match(sweep, /const activeCandidates = await all[\s\S]*const cleanupCandidates = await all/);
  assert.match(sweep, /catch \{[\s\S]{0,700}UPDATE assets SET updated_at = \?[\s\S]{0,500}continue;/);
  assert.match(
    core.slice(core.indexOf("export async function initializeAsset"), core.indexOf("function maxAssetBytes")),
    /expireStaleAssetUploads\(scope, \{ eventId \}\)[\s\S]{0,300}findMutationReplay/,
    "asset init must sweep before replaying an abandoned init response",
  );
  assert.match(
    core.slice(core.indexOf("export async function getEvent"), core.indexOf("export async function createTranscriptImport")),
    /expireStaleAssetUploads\(scope, \{ eventId \}\)[\s\S]{0,1600}eventRecord\(event\)/,
  );
  assert.match(
    workflow,
    /getProject\(scope, projectId\)[\s\S]{0,100}expireStaleAssetUploads\(scope, \{ projectId \}\)/,
  );

  const expireCasSql = sql(
    sweep,
    /`(UPDATE assets\s+SET processing_status = 'failed', failure_code = 'UPLOAD_EXPIRED'[^`]*?updated_at < \?)`/,
    "stale upload CAS",
  );
  const heartbeatSql = sql(
    heartbeat,
    /`(UPDATE assets SET updated_at = \?[^`]*?processing_status = 'uploading')`/,
    "upload heartbeat CAS",
  );
  const cleanupSql = sql(
    sweep,
    /`(UPDATE assets\s+SET staged_r2_key = NULL[^`]*?failure_code IN \('UPLOAD_ABORTED', 'UPLOAD_EXPIRED'\)[^`]*?staged_r2_key = \?)`/,
    "stale object cleanup",
  );
  const eventRecoverySql = sql(
    readiness,
    /`(UPDATE events\s+SET material_status = CASE[^`]*?WHERE id = \? AND workspace_id = \?)`/,
    "stale Event recovery",
  );
  const uploadCasSql = sql(
    upload,
    /`(UPDATE assets[^`]*?processing_status = 'uploading' AND staged_r2_key IS NULL)`/,
    "content upload CAS",
  );
  const materialCountsMatch = workflow.match(
    /WITH material_counts AS \(\s*([\s\S]*?GROUP BY event_id)\s*\)\s*SELECT/,
  );
  assert.ok(materialCountsMatch);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        current_version_id TEXT,
        staged_r2_key TEXT,
        staged_sha256 TEXT,
        staged_mime_type TEXT,
        staged_size_bytes INTEGER,
        failure_code TEXT,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        material_status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO events VALUES
        ('event-stale', 'ws-a', 'draft', 'old'),
        ('event-staged', 'ws-a', 'draft', 'old'),
        ('event-fresh', 'ws-a', 'draft', 'new');
      INSERT INTO assets VALUES
        ('ready-stale', 'ws-a', 'project-a', 'event-stale', 'ready', 'av-ready-stale', 'r2/ready-stale', 'sha-ready-stale', 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z'),
        ('lost-upload', 'ws-a', 'project-a', 'event-stale', 'uploading', NULL, NULL, NULL, 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z'),
        ('ready-staged', 'ws-a', 'project-a', 'event-staged', 'ready', 'av-ready-staged', 'r2/ready-staged', 'sha-ready-staged', 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z'),
        ('lost-staged', 'ws-a', 'project-a', 'event-staged', 'parsing', NULL, 'r2/lost-staged', 'sha-lost-staged', 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z'),
        ('fresh-upload', 'ws-a', 'project-a', 'event-fresh', 'uploading', NULL, NULL, NULL, 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z'),
        ('other-scope', 'ws-b', 'project-b', 'event-other', 'uploading', NULL, NULL, NULL, 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z'),
        ('already-final', 'ws-a', 'project-a', 'event-stale', 'ready', 'av-final', 'r2/final', 'sha-final', 'text/plain', 3, NULL, '{}', '2026-08-30T00:00:00.000Z');
    `);
    const heartbeatCas = database.prepare(heartbeatSql);
    assert.equal(
      heartbeatCas.run("2026-08-30T00:20:00.000Z", "fresh-upload", "ws-a").changes,
      1,
      "a healthy slow upload must renew its lease before the stale sweep",
    );
    assert.equal(heartbeatCas.run("2026-08-30T00:20:00.000Z", "other-scope", "ws-a").changes, 0);
    assert.equal(heartbeatCas.run("2026-08-30T00:20:00.000Z", "already-final", "ws-a").changes, 0);
    assert.equal(heartbeatCas.run("2026-08-30T00:20:00.000Z", "lost-staged", "ws-a").changes, 0);
    const expireCas = database.prepare(expireCasSql);
    const cutoff = "2026-08-30T00:05:00.000Z";
    assert.equal(expireCas.run("2026-08-30T00:20:00.000Z", "lost-upload", "ws-a", cutoff).changes, 1);
    assert.equal(expireCas.run("2026-08-30T00:20:00.000Z", "lost-staged", "ws-a", cutoff).changes, 1);
    assert.equal(expireCas.run("2026-08-30T00:20:00.000Z", "fresh-upload", "ws-a", cutoff).changes, 0);
    assert.equal(expireCas.run("2026-08-30T00:20:00.000Z", "other-scope", "ws-a", cutoff).changes, 0);
    assert.equal(expireCas.run("2026-08-30T00:20:00.000Z", "already-final", "ws-a", cutoff).changes, 0);
    assert.equal(expireCas.run("2026-08-30T00:21:00.000Z", "lost-upload", "ws-a", cutoff).changes, 0);
    assert.equal(
      database.prepare(uploadCasSql).run(
        "r2/late", "sha-late", "text/plain", 3, "2026-08-30T00:21:00.000Z", "lost-upload", "ws-a",
      ).changes,
      0,
      "an upload response arriving after lease expiry cannot revive the tombstone",
    );

    const stagedKey = database.prepare("SELECT staged_r2_key FROM assets WHERE id = 'lost-staged'").get().staged_r2_key;
    const storedObjects = new Set([stagedKey]);
    storedObjects.delete(stagedKey);
    assert.equal(
      database.prepare(cleanupSql).run(
        "2026-08-30T00:21:00.000Z", "lost-staged", "ws-a", stagedKey,
      ).changes,
      1,
    );
    assert.equal(storedObjects.size, 0);

    const recoverEvent = database.prepare(eventRecoverySql);
    recoverEvent.run("event-stale", "ws-a", "event-stale", "ws-a", "2026-08-30T00:21:00.000Z", "event-stale", "ws-a");
    recoverEvent.run("event-staged", "ws-a", "event-staged", "ws-a", "2026-08-30T00:21:00.000Z", "event-staged", "ws-a");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-stale'").get().material_status, "ready");
    assert.equal(database.prepare("SELECT material_status FROM events WHERE id = 'event-staged'").get().material_status, "ready");

    const counts = database.prepare(materialCountsMatch[1]).all("ws-a");
    const byEvent = new Map(counts.map((row) => [row.event_id, row]));
    assert.deepEqual(
      { ...byEvent.get("event-stale") },
      { event_id: "event-stale", material_total: 2, material_ready: 2, material_processing: 0, material_failed: 0 },
    );
    assert.deepEqual(
      { ...byEvent.get("event-staged") },
      { event_id: "event-staged", material_total: 1, material_ready: 1, material_processing: 0, material_failed: 0 },
    );
    assert.equal(byEvent.get("event-fresh").material_processing, 1, "a fresh upload must keep its active lease");
  } finally {
    database.close();
  }
});

test("database verdict paths preserve the domain state and evidence rules", async () => {
  const verdicts = await read("lib/server/db/verdict-repository.ts");
  const confirmSection = verdicts.slice(
    verdicts.indexOf('if (input.action === "confirm")'),
    verdicts.indexOf('} else if (input.action === "reject")'),
  );
  const rejectSection = verdicts.slice(
    verdicts.indexOf('} else if (input.action === "reject")'),
    verdicts.indexOf("} else {", verdicts.indexOf('} else if (input.action === "reject")')),
  );
  const editSection = verdicts.slice(
    verdicts.indexOf("} else {", verdicts.indexOf("export async function applyClaimVerdict")),
    verdicts.indexOf("export async function withdrawClaim"),
  );
  const batchSection = verdicts.slice(
    verdicts.indexOf("export async function applyBatchVerdicts"),
    verdicts.indexOf("export async function applyOccurrenceVerdict"),
  );
  const occurrenceSection = verdicts.slice(
    verdicts.indexOf("export async function applyOccurrenceVerdict"),
    verdicts.indexOf("export async function resolveContradiction"),
  );
  const contradictionSection = verdicts.slice(
    verdicts.indexOf("export async function resolveContradiction"),
  );
  const withdrawSection = verdicts.slice(
    verdicts.indexOf("export async function withdrawClaim"),
    verdicts.indexOf("export async function applyBatchVerdicts"),
  );

  assert.match(
    verdicts,
    /semantic_support_verdict\s*=\s*CASE evidence_role[\s\S]{0,260}WHEN 'direct' THEN 'fully_supports'[\s\S]{0,180}WHEN 'corroborating' THEN 'partially_supports'/i,
    "reviewed direct and corroborating Evidence must receive deterministic support verdicts",
  );
  assert.match(
    confirmSection,
    /acceptReviewedEvidenceStatement\(input\.base_version_id\)/,
    "single confirm must accept reviewed Evidence in the same atomic batch",
  );
  assert.doesNotMatch(
    rejectSection,
    /acceptReviewedEvidenceStatement|semantic_support_verdict/i,
    "rejecting a Claim must not rewrite the semantic meaning of its Evidence",
  );
  assert.doesNotMatch(
    withdrawSection,
    /acceptReviewedEvidenceStatement|semantic_support_verdict/i,
    "withdrawing a verified Claim must preserve historical Evidence support",
  );

  assert.match(
    editSection,
    /review_status\s+IN\s*\([^)]*'pending'[^)]*'verified'[^)]*\)[\s\S]{0,180}lifecycle_status\s*<>\s*'withdrawn'/i,
    "DB edit CAS must reject a withdrawn claim, not only rely on the pure helper",
  );
  assert.match(
    editSection,
    /row\.evidence_role === ["']direct["'][\s\S]{0,140}["']fully_supports["'][\s\S]{0,160}row\.evidence_role === ["']corroborating["'][\s\S]{0,140}["']partially_supports["']/i,
    "an edit must mark only the explicitly selected supporting Evidence for its new version",
  );
  assert.doesNotMatch(
    editSection,
    /existing\.normalized_value_json|uncertainty_json[\s\S]{0,80}NULL,\s*'human'/i,
    "an edit must not silently inherit normalized data or erase uncertainty",
  );
  assert.match(
    editSection,
    /retain_relation_ids[\s\S]*?replaces_relation_id[\s\S]*?'active'/i,
    "retained relations must be recreated for the new source version and linked to history",
  );
  assert.match(
    editSection,
    /target\.current_version_id\s*=\s*r\.target_claim_version_id[\s\S]*?target\.review_status\s*=\s*'verified'[\s\S]*?target\.lifecycle_status\s*<>\s*'withdrawn'/i,
    "carried relations must target the current verified non-withdrawn version",
  );
  assert.match(
    editSection,
    /supportingEvidenceIds[\s\S]*?evidence_role\s*===\s*["']direct["'][\s\S]*?evidence_role\s*===\s*["']corroborating["'][\s\S]*?EVIDENCE_SUPPORT_REQUIRED/i,
    "an edit cannot become verified with contextual-only evidence",
  );
  assert.match(
    editSection,
    /guardStatement[\s\S]*?evidence_refs[\s\S]*?evidence_role\s+IN\s*\([^)]*'direct'[^)]*'corroborating'/i,
    "the edit evidence requirement must be part of the atomic verdict guard",
  );
  assert.match(
    batchSection,
    /evidence_refs[\s\S]{0,600}structural_validation_status\s*=\s*'valid'[\s\S]{0,300}evidence_role\s+IN\s*\([^)]*'direct'[^)]*'corroborating'/i,
    "batch confirm must validate usable evidence for every claim",
  );
  assert.match(
    batchSection,
    /claim_evidence_review_attestations[\s\S]{0,350}actor_id\s*=\s*\?[\s\S]{0,300}EVIDENCE_REVIEW_REQUIRED/i,
    "batch confirmation must reject a Claim without this actor's persisted evidence review",
  );
  assert.match(
    batchSection,
    /claim_evidence_review_attestations[\s\S]{0,500}guardBindings[\s\S]{0,900}acceptReviewedEvidenceStatement\(item\.base_version_id\)/i,
    "batch review readiness and semantic support updates must be part of the atomic verdict path",
  );
  assert.match(
    batchSection,
    /RELATION_REVIEW_REQUIRED[\s\S]{0,2200}NOT EXISTS \([\s\S]{0,300}claim_relations[\s\S]{0,240}status = 'proposed'/i,
    "batch confirm must reject every Claim with an undecided proposed relationship",
  );
  assert.match(
    occurrenceSection,
    /evidence_refs[\s\S]{0,500}workspace_id\s*=\s*\?[\s\S]{0,400}project_id\s*=\s*\?[\s\S]{0,400}event_id\s*=\s*\?[\s\S]{0,400}structural_validation_status\s*=\s*'valid'/i,
    "occurrence confirm must prove its evidence exists, is valid, and belongs to the same scope",
  );
  assert.match(
    contradictionSection,
    /baseRelationStatus\s*!==\s*["']active["'][\s\S]{0,200}relation\.status\s*!==\s*["']active["']/,
    "contradiction resolution must only accept an active relation",
  );
});

test("legacy batch confirmation remains server-gated while the simplified UI stays single-record", async () => {
  const schema = await read("db/schema.ts");
  const repository = await read("lib/server/db/verdict-repository.ts");
  const route = await read("app/api/v1/[...segments]/route.ts");
  const client = await read("app/api-client.ts");
  const page = uiSource;

  assert.match(schema, /claimEvidenceReviewAttestations[\s\S]{0,1000}actorId[\s\S]{0,500}claimVersionId/);
  assert.match(
    repository,
    /export async function attestClaimEvidenceReview[\s\S]{0,1400}review_status = 'pending'[\s\S]{0,900}evidence_role IN \('direct', 'corroborating'\)[\s\S]{0,900}INSERT OR IGNORE INTO claim_evidence_review_attestations/i,
    "attestation must prove a pending current version has usable Evidence before persisting",
  );
  assert.match(route, /evidence-review-attestations[\s\S]{0,400}attestClaimEvidenceReview[\s\S]{0,300}idempotencyKey\(request\)/i);
  assert.match(client, /async attestEvidenceReview[\s\S]{0,500}idempotency-key/);
  assert.doesNotMatch(page, /批量处理选项|确认所选|className="claim-select"/);
  assert.match(page, /aria-label="确认并加入正式结果"[\s\S]{0,500}aria-label="修改后确认"[\s\S]{0,500}aria-label="不采纳这条记录"/);
  assert.doesNotMatch(
    page,
    /useState<Set<string>>\([^)]*reviewed|localStorage[\s\S]{0,300}batchReviewAttested/i,
    "batch readiness must not be simulated with browser-only state",
  );
});

test("model-proposed Claim relations require explicit human decisions", async () => {
  const sharedTypes = await read("lib/shared/api-types.ts");
  const repository = await read("lib/server/db/verdict-repository.ts");
  const route = await read("app/api/v1/[...segments]/route.ts");
  const client = await read("app/api-client.ts");
  const page = uiSource;
  const confirmSection = repository.slice(
    repository.indexOf('if (input.action === "confirm")'),
    repository.indexOf('} else if (input.action === "reject")'),
  );
  const batchSection = repository.slice(
    repository.indexOf("export async function applyBatchVerdicts"),
    repository.indexOf("export async function applyOccurrenceVerdict"),
  );

  assert.match(sharedTypes, /ClaimVerdictRequest[\s\S]{0,220}retain_relation_ids\?: string\[\]/);
  assert.match(route, /action === ["']confirm["'][\s\S]{0,300}["']retain_relation_ids["'] in body[\s\S]{0,350}stringArray/);
  assert.match(client, /action === ["']confirm["'][\s\S]{0,180}retain_relation_ids: input\.retainRelationIds/);
  assert.match(confirmSection, /proposedRelations[\s\S]{0,900}relationDecisions/);
  assert.match(confirmSection, /UPDATE claim_relations SET status = \?[\s\S]{0,700}INSERT INTO relation_verdicts/);
  assert.doesNotMatch(
    confirmSection,
    /UPDATE claim_relations SET status = 'active'[\s\S]{0,180}source_claim_version_id = \?/,
    "single confirmation must never activate every model-proposed relationship",
  );
  assert.match(batchSection, /RELATION_REVIEW_REQUIRED[\s\S]{0,2200}status = 'proposed'/);
  assert.doesNotMatch(
    batchSection,
    /item\.action === ["']confirm["'][\s\S]{0,2500}UPDATE claim_relations SET status = 'active'/,
    "batch confirmation must not activate a proposed relationship",
  );
  assert.match(page, /逐条核对关系[\s\S]{0,1400}接受关系[\s\S]{0,500}拒绝关系/);
  assert.match(page, /旧记录：[\s\S]{0,900}relationReviewEffect/);
  assert.match(page, /!relationsReviewed[\s\S]{0,500}acceptedRelationIds/);
});

test("timeline repository loads historical claim versions used by relations and withdrawals", async () => {
  const ledger = await read("lib/server/db/ledger-repository.ts");
  assert.match(
    ledger,
    /FROM claim_versions cv[\s\S]{0,240}JOIN claims c[\s\S]{0,300}c\.project_id\s*=\s*\?[\s\S]{0,120}c\.workspace_id\s*=\s*\?/i,
    "the ledger must load every in-scope version, not only each claim's current version",
  );
  assert.match(
    ledger,
    /claimVersions\s*=\s*versionRows\.map\(versionRecord\)/i,
    "historical version rows must be converted to canonical domain records",
  );
  assert.match(
    ledger,
    /claims,\s*claimVersions,\s*relations,/i,
    "historical versions must be passed to the deterministic Timeline builder",
  );
});

test("first-event extraction owns one persisted scenario assessment lease", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const extraction = core.slice(
    core.indexOf("export async function createExtractionRun"),
    core.indexOf("export async function getExtractionRun"),
  );

  assert.match(
    extraction,
    /scenario_status\s*=\s*'unassessed'[\s\S]{0,900}scenario_status\s*=\s*'assessing'[\s\S]{0,300}scenario_assessment_run_id\s*=\s*\?/i,
    "the first run must atomically acquire the Project scenario lease",
  );
  assert.match(
    extraction,
    /scenario_lease_expires_at\s*=\s*\?[\s\S]{0,250}scenario_assessment_attempt\s*=\s*scenario_assessment_attempt\s*\+\s*1/i,
    "the scenario lease needs an expiry and an audited attempt counter",
  );
  assert.match(
    extraction,
    /INSERT INTO mutation_guards[\s\S]*?scenario_status\s*=\s*'unassessed'[\s\S]*?sequence_no\s*=\s*1[\s\S]*?UPDATE projects[\s\S]*?scenario_status\s*=\s*'assessing'/i,
    "the first-event eligibility check and lease mutation must share the same atomic D1 batch",
  );
});

test("workspace run concurrency is enforced before queueing without a daily model ceiling", async () => {
  const schema = await read("db/schema.ts");
  const core = await read("lib/server/db/core-repository.ts");
  const extraction = core.slice(
    core.indexOf("export async function createExtractionRun"),
    core.indexOf("export async function getExtractionRun"),
  );

  assert.match(
    schema,
    /mutationGuards[\s\S]*?guardValue[\s\S]*?check\([^)]*ck_mutation_guards_true[\s\S]*?guardValue}\s*=\s*1/i,
    "a false mutation guard must violate a database CHECK and roll back its D1 batch",
  );
  assert.match(
    extraction,
    /MAX_CONCURRENT_RUNS_PER_WORKSPACE[\s\S]*?INSERT INTO mutation_guards[\s\S]*?COUNT\(\*\) FROM extraction_runs[\s\S]*?status IN \('queued', 'processing'\)[\s\S]*?<\s*\?/i,
    "queued and processing runs must be counted in the same guarded batch as the new run",
  );
  assert.doesNotMatch(extraction, /MAX_DAILY_MODEL_TOKENS|max_daily_model_tokens|daily_tokens/i);
  assert.match(extraction, /token_budget_policy:\s*"per-run-safety\.v1"/);
  assert.match(
    extraction,
    /activeCount\s*>=\s*maxConcurrentRuns[\s\S]*?429[\s\S]*?WORKSPACE_RUN_LIMIT/i,
    "a failed concurrency guard must be translated to the stable 429 WORKSPACE_RUN_LIMIT contract",
  );
});

test("one Event can own only one active paid Run across tabs and devices", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const extraction = core.slice(
    core.indexOf("export async function createExtractionRun"),
    core.indexOf("export async function getExtractionRun"),
  );

  assert.match(
    extraction,
    /const activeEventRun = await first[\s\S]{0,700}activeEventRun\.input_hash\) !== inputHash[\s\S]{0,180}RUN_STATE_CONFLICT[\s\S]{0,900}created: false/,
    "the normal path must reuse an identical active Event Run and reject a different manifest",
  );
  assert.match(
    extraction,
    /NOT EXISTS \([\s\S]{0,220}FROM extraction_runs[\s\S]{0,180}event_id = \? AND workspace_id = \?[\s\S]{0,120}status IN \('queued', 'processing'\)/,
    "the same-Event active check must be inside the Run/outbox transaction",
  );
  const raceAt = extraction.indexOf("const activeEventRace");
  const quotaAt = extraction.indexOf("const quotaState", raceAt);
  assert.ok(raceAt >= 0 && quotaAt > raceAt, "same-Event race recovery must run before workspace quota classification");
  const raceSection = extraction.slice(raceAt, quotaAt);
  assert.match(raceSection, /input_hash\) !== inputHash[\s\S]{0,180}RUN_STATE_CONFLICT/);
  assert.match(raceSection, /created: false/);

  const guardMatch = extraction.match(
    /`(INSERT INTO mutation_guards \(id, guard_value, created_at\)\s+SELECT \?, CASE WHEN NOT EXISTS \([^`]*?status IN \('queued', 'processing'\)[^`]*?END, \?)`/,
  );
  assert.ok(guardMatch, "same-Event mutation guard SQL was not found");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE mutation_guards (
        id TEXT PRIMARY KEY,
        guard_value INTEGER NOT NULL CHECK (guard_value = 1),
        created_at TEXT NOT NULL
      );
      CREATE TABLE extraction_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL
      );
      CREATE TABLE queue_outbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        active_run_id TEXT
      );
      INSERT INTO events VALUES ('event-a', 'ws-a', NULL);
    `);
    const guard = database.prepare(guardMatch[1]);
    const attempt = (runId, inputHash) => {
      database.exec("BEGIN");
      try {
        guard.run(`guard-${runId}`, "event-a", "ws-a", `t-${runId}`);
        database.prepare("INSERT INTO extraction_runs VALUES (?, 'ws-a', 'event-a', 'queued', ?)").run(runId, inputHash);
        database.prepare("INSERT INTO queue_outbox VALUES (?, ?)").run(`out-${runId}`, runId);
        database.prepare("UPDATE events SET active_run_id = ? WHERE id = 'event-a' AND workspace_id = 'ws-a'").run(runId);
        database.prepare("DELETE FROM mutation_guards WHERE id = ?").run(`guard-${runId}`);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    attempt("run-a", "hash-a");
    assert.throws(() => attempt("run-b", "hash-a"), /CHECK constraint failed/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM extraction_runs").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM queue_outbox").get().count, 1);
    assert.equal(database.prepare("SELECT active_run_id FROM events WHERE id = 'event-a'").get().active_run_id, "run-a");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mutation_guards").get().count, 0);

    database.prepare("UPDATE extraction_runs SET status = 'succeeded' WHERE id = 'run-a'").run();
    attempt("run-b", "hash-b");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM extraction_runs").get().count, 2);
    assert.equal(database.prepare("SELECT active_run_id FROM events WHERE id = 'event-a'").get().active_run_id, "run-b");
  } finally {
    database.close();
  }
});

test("processor persists sanitized snapshots and binds transcript evidence to one asset version", async () => {
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const snapshotView = processor.slice(
    processor.indexOf("function contextSnapshotView"),
    processor.indexOf("async function", processor.indexOf("function contextSnapshotView")),
  );

  assert.match(
    snapshotView,
    /function\s+contextSnapshotView[\s\S]{0,800}modelUrl\s*:\s*`\[asset-version:\$\{photo\.assetVersionId\}\]`/i,
    "context snapshots must reference image IDs instead of storing image base64",
  );
  assert.doesNotMatch(
    snapshotView,
    /data:image|;base64,/i,
    "the persisted snapshot projection must never construct an image data URL or base64 payload",
  );
  assert.match(
    processor,
    /JSON\.stringify\(contextSnapshotView\(contextPack\)\)/,
    "the persisted D1 snapshot must use the sanitized Context Pack",
  );
  assert.match(
    processor,
    /allowedSegmentIds\s*:\s*new Set\([\s\S]{0,240}segment\.assetVersionId\s*===\s*item\.asset_version_id/i,
    "a transcript evidence pointer must only use segments from its declared asset version",
  );
  assert.match(
    processor,
    /canonical\.assetVersionId\s*!==\s*item\.asset_version_id[\s\S]{0,160}EVIDENCE_SCOPE_INVALID/i,
    "canonical evidence must reject a model-declared asset mismatch",
  );
});

test("reaffirmed evidence stays pending until occurrence confirmation materializes it", async () => {
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const verdicts = await read("lib/server/db/verdict-repository.ts");
  const occurrenceSection = verdicts.slice(
    verdicts.indexOf("export async function applyOccurrenceVerdict"),
    verdicts.indexOf("export async function resolveContradiction"),
  );

  assert.match(
    processor,
    /schema_version\s*:\s*["']occurrence-evidence\.v1["'][\s\S]{0,180}evidence\s*:\s*occurrence\.evidence/i,
    "the processor must retain canonical evidence with the pending occurrence candidate",
  );
  assert.match(
    occurrenceSection,
    /schema_version\s*===\s*["']occurrence-evidence\.v1["']/i,
    "occurrence confirmation must understand the candidate evidence contract",
  );
  assert.match(
    occurrenceSection,
    /const\s+evidenceInsertStatements\s*=[\s\S]{0,250}candidateEvidence\.map/i,
    "occurrence confirmation must materialize the candidate evidence contract",
  );
  assert.match(
    occurrenceSection,
    /await db\.batch\(\[/i,
    "occurrence verdict writes must use one D1 batch",
  );
  assert.match(
    occurrenceSection,
    /input\.action\s*===\s*["']confirm["'][\s\S]*?\.\.\.evidenceInsertStatements[\s\S]*?INSERT INTO claim_occurrences[\s\S]*?:\s*\[\]/i,
    "confirm must atomically insert evidence and one immutable occurrence while reject inserts neither",
  );
  assert.match(
    occurrenceSection,
    /UPDATE claim_occurrence_candidates SET status\s*=\s*\?[\s\S]*?INSERT INTO occurrence_verdicts[\s\S]*?mutationReplayStatement/i,
    "confirm and reject must persist the candidate state, verdict, and replay record in that batch",
  );
});

test("provider schema and server validator share bounded output limits", async () => {
  const provider = await read("lib/server/ai/model-provider.ts");
  const contract = await read("lib/domain/model-contract.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");

  assert.match(provider, /MODEL_CONTRACT_LIMITS/);
  for (const bound of [
    "claims",
    "evidencePerClaim",
    "relationsPerClaim",
    "segmentIdsPerEvidence",
    "alternativesPerUncertainty",
    "statementLength",
    "normalizedValueJsonLength",
  ]) {
    assert.match(contract, new RegExp(`\\b${bound}\\b`), `missing shared model bound ${bound}`);
  }
  assert.match(
    provider,
    /max_output_tokens\s*:\s*this\.maxOutputTokens[\s\S]*?max_tokens\s*:\s*this\.maxOutputTokens/i,
    "every supported provider adapter must set a finite output-token limit",
  );
  assert.match(
    provider,
    /endpoint\s*=\s*isOpenAi\s*\?\s*["']responses["'][\s\S]*?reasoning\s*:\s*\{\s*effort\s*:\s*this\.reasoningEffort\s*\}/i,
    "OpenAI extraction must use Responses with an explicit reasoning effort",
  );
  assert.match(
    provider,
    /type:\s*["']input_image["'][\s\S]{0,180}detail:\s*["']original["']/i,
    "OpenAI image evidence must preserve original detail for OCR and bbox review",
  );
  assert.match(
    provider,
    /body\.status\s*===\s*["']incomplete["'][\s\S]{0,500}ModelOutputInvalidError/i,
    "an incomplete OpenAI response must fail before partial output can be persisted",
  );
  assert.match(
    provider,
    /content\.type\s*===\s*["']refusal["'][\s\S]{0,300}ModelOutputInvalidError/i,
    "an OpenAI refusal must fail explicitly instead of being parsed as Claim JSON",
  );
  assert.doesNotMatch(
    provider,
    /temperature\s*:/i,
    "reasoning-model requests must not force a temperature",
  );
  assert.match(
    provider,
    /scenario_assessment[\s\S]{0,900}candidates[\s\S]{0,250}minItems:\s*2[\s\S]{0,120}maxItems:\s*3/i,
    "first-scenario candidates must be constrained to two or three in the provider schema",
  );
  assert.match(
    provider,
    /uncertainty:\s*\{[\s\S]{0,500}alternatives:\s*\{[\s\S]{0,120}minItems:\s*2/i,
    "structured uncertainty must contain at least two plausible alternatives",
  );
  assert.doesNotMatch(
    provider,
    /claims:\s*\{\s*type:\s*["']array["'],\s*minItems:/i,
    "the provider schema must not force filler Claims when fewer than five material propositions exist",
  );
  assert.match(provider, /strict:\s*true/i, "OpenAI Structured Outputs must use strict schema enforcement");
  assert.doesNotMatch(provider, /strict:\s*false|\boneOf\s*:|maxProperties\s*:/i);
  assert.match(
    provider,
    /return no more than 10[\s\S]{0,260}Never combine propositions merely to fit the limit/i,
    "the prompt must rank at most ten material propositions without combining them to fit the cap",
  );
  assert.match(
    provider,
    /never return only one/i,
    "the prompt must explicitly reject a single scenario candidate",
  );
  assert.match(
    provider,
    /validateExtractClaimsOutput\(decoded\.value\)/,
    "provider output must cross the authoritative structural validator before it reaches the processor",
  );
  assert.match(
    processor,
    /validateExtractClaimsOutput\(finalOutput,\s*input\.contextPack\)/,
    "the processor must revalidate provider output structure before persistence",
  );
  assert.match(
    processor,
    /prepareCandidates\(output,\s*run,\s*manifestRows,\s*segments,\s*ledger\.claims\)/,
    "the processor must deterministically filter stale relation targets before persistence",
  );
  assert.match(
    processor,
    /RELATION_TARGET_CONFLICT[\s\S]{0,1200}RELATION_SEMANTICS_INVALID[\s\S]{0,1200}RELATION_LIFECYCLE_CONFLICT/,
    "context-sensitive relation failures must be retained as bounded warnings rather than discarding grounded Claims",
  );
  assert.match(
    provider,
    /Use disposition=reaffirmed only when[\s\S]{0,700}relations=\[\]/i,
    "the prompt must reserve reaffirmed for unchanged atomic facts without relations",
  );
  assert.match(
    provider,
    /split every material change[\s\S]{0,300}new atomic claims/i,
    "the prompt must split material changes out of mixed reaffirmed source sentences",
  );
  assert.match(
    provider,
    /Relation policy:[\s\S]{0,900}Never attach both supersedes and resolves to the same target/i,
    "the prompt must define mutually exclusive lifecycle relation semantics",
  );
  assert.match(
    provider,
    /lifecycleStatus, uncertainty, openedAt, lastRepeatedAt, and repeatCount/i,
    "the model must receive the target lifecycle and uncertainty needed for stable relation decisions",
  );
  assert.match(
    provider,
    /Set needs_additional_evidence=true[\s\S]{0,650}Never return uncertainty with needs_additional_evidence=false/i,
    "the prompt must distinguish a simple evidence gap from a structured multi-alternative uncertainty",
  );
  assert.match(
    processor,
    /leased\.prompt_version[\s\S]{0,400}STALE_MODEL_CONTRACT[\s\S]{0,500}loadContextInput/i,
    "a queued run created under an older prompt or schema must fail before it can spend a model request",
  );
  assert.match(
    processor,
    /inventoryProvider\.inventoryClaims/i,
    "the current contract must begin with the inventory model stage",
  );
  assert.match(
    contract,
    /claim\.disposition === ["']reaffirmed["'][\s\S]{0,260}claim\.relations\.length > 0/i,
    "the local validator must reject relations attached to reaffirmed occurrences",
  );
});

test("failed local model validation retains safe provider usage without raw output", async () => {
  const provider = await read("lib/server/ai/model-provider.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const failedSection = processor.slice(
    processor.indexOf("async function markRunFailed"),
    processor.indexOf("export async function processExtractionRun"),
  );

  assert.match(
    provider,
    /new ModelOutputInvalidError\(validated\.issues,\s*usage\)/i,
    "invalid output errors must carry usage returned with the provider response",
  );
  for (const field of ["input_tokens", "output_tokens", "cached_tokens", "provider_request_id"]) {
    assert.match(failedSection, new RegExp(`\\b${field}\\b`), `failed runs must retain safe ${field}`);
  }
  assert.doesNotMatch(
    failedSection,
    /validated_output_json\s*=/i,
    "failed runs must not persist unvalidated provider output",
  );
});

test("outbox only acknowledges lease contention when another run owner can finish the work", async () => {
  const outbox = await read("lib/server/jobs/outbox.ts");
  const dispatch = outbox.slice(
    outbox.indexOf("export async function dispatchDueOutbox"),
    outbox.indexOf("export async function sweepJobs"),
  );

  assert.match(
    dispatch,
    /processed\.status\s*===\s*["']lease_not_acquired["'][\s\S]*?SELECT status FROM extraction_runs/i,
    "lease contention must be disambiguated from a transient lease-acquisition failure",
  );
  assert.match(
    dispatch,
    /status\s*===\s*["']processing["'][\s\S]*?completed_with_warnings[\s\S]*?markSent/i,
    "processing or terminal work may acknowledge the duplicate outbox delivery",
  );
  assert.match(
    dispatch,
    /else\s*\{[\s\S]*?markDispatchFailure\([^)]*RUN_LEASE_NOT_ACQUIRED[\s\S]*?result\.deferred\s*\+=\s*1/i,
    "a still-queued or missing run must remain retryable instead of being marked sent",
  );
  assert.match(
    dispatch,
    /processor-level\s+`failed`[\s\S]*?markSent/i,
    "a persisted terminal failed run is handled work and must not trigger a duplicate model call",
  );
});

test("long-running dispatch checkpoints OpenAI work and preserves durable recovery", async () => {
  const modelConfig = await read("lib/domain/model-config.ts");
  const core = await read("lib/server/db/core-repository.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const outbox = await read("lib/server/jobs/outbox.ts");
  const worker = await read("worker/index.ts");

  assert.match(
    modelConfig,
    /EXTRACTION_RUN_LEASE_MS\s*=\s*30\s*\*\s*60_000[\s\S]{0,300}MAX_AI_TIMEOUT_MS\s*=\s*9\s*\*\s*60_000/i,
    "the three-stage pipeline must keep each provider call bounded inside the Run lease",
  );
  assert.match(
    core,
    /timeoutMs\s*=\s*normalizeAiTimeoutMs\(bindings\.AI_TIMEOUT_MS\)/,
    "Run creation must freeze a bounded provider timeout",
  );
  assert.match(
    processor,
    /leaseDurationMs\s*=\s*EXTRACTION_RUN_LEASE_MS[\s\S]{0,1800}plusMilliseconds\(timestamp,\s*leaseDurationMs\)/,
    "scheduled processing must default to the shared pipeline lease while permitting a shorter HTTP checkpoint",
  );
  assert.match(
    outbox,
    /TARGETED_HTTP_CHECKPOINT_LEASE_MS\s*=\s*40_000[\s\S]*?leaseOutbox\([\s\S]*?targetedHttpCheckpoint\s*\?\s*TARGETED_HTTP_CHECKPOINT_LEASE_MS/,
    "a browser-targeted OpenAI checkpoint must write its short outbox lease in the initial guarded claim",
  );
  assert.match(
    processor,
    /releaseRunForBackgroundPoll[\s\S]{0,1200}getD1\(\)\.batch\(\[[\s\S]{0,900}UPDATE extraction_runs[\s\S]{0,1400}UPDATE queue_outbox[\s\S]{0,500}BACKGROUND_RESPONSE_PENDING/,
    "persisted background work must release the Run and requeue its durable outbox message atomically",
  );
  assert.match(
    outbox,
    /r\.model_params_json\s+AS\s+run_model_params_json/i,
    "the dispatcher must load the Run's frozen model parameters",
  );
  assert.match(
    outbox,
    /modelParams\.timeout_ms[\s\S]{0,180}modelParams\.max_model_stages[\s\S]{0,300}outboxLeaseDurationMs\(frozenTimeoutMs,\s*frozenMaxStages\)/i,
    "Outbox lease duration must be derived from the frozen timeout",
  );
  assert.match(
    outbox,
    /POC_DISPATCH_BATCH_LIMIT\s*=\s*1/,
    "each POC dispatcher invocation must claim at most one long Run",
  );
  assert.match(
    outbox,
    /bindings\.push\(POC_DISPATCH_BATCH_LIMIT\)[\s\S]{0,900}LIMIT\s+\?`/i,
    "the database claim limit must use the one-job POC constant",
  );
  assert.doesNotMatch(
    outbox,
    /dispatchDueOutbox\(5\)/,
    "the cron path must not process five long model calls serially",
  );
  assert.match(
    outbox,
    /target\s*&&\s*String\(row\.run_provider\)\s*===\s*["']openai["'][\s\S]{0,160}hasFrozenTwoPassPipeline[\s\S]{0,2000}processExtractionRun\([\s\S]{0,300}leaseDurationMs:\s*TARGETED_HTTP_CHECKPOINT_LEASE_MS[\s\S]{0,100}dispatchOutboxOwner:\s*owner/,
    "only a frozen two-pass OpenAI Run may enter the owner-fenced short HTTP checkpoint",
  );
  assert.match(
    processor,
    /EXTRACTION_STAGE_STALE_AFTER_MS[\s\S]{0,2400}extraction_model_stages[\s\S]{0,900}IN \('xhigh', 'high'\)/i,
    "a stale xhigh/high model stage must be recoverable without permitting a frozen max Run",
  );
  assert.match(
    processor,
    /UPDATE queue_outbox[\s\S]{0,700}STALE_MODEL_STAGE[\s\S]{0,700}status = 'queued'/i,
    "recovering a stale Run must make its durable outbox message dispatchable again",
  );
  assert.match(
    worker,
    /ctx\.waitUntil\(Promise\.all\(\[[\s\S]{0,300}dispatchExtractionRun\(workspaceId,\s*input\.runId\)[\s\S]{0,200}dispatchEventAiArtifactsForExtraction\(workspaceId,\s*input\.runId\)/,
    "one visible browser kick must checkpoint the extraction and its independent reading artifacts",
  );
  assert.match(
    worker,
    /return dispatchResponse\(\{[\s\S]{0,240}run_id:\s*input\.runId[\s\S]{0,160}\},\s*requestId,\s*202\)/,
    "the targeted checkpoint must acknowledge the durable Run with 202",
  );
  assert.match(
    worker,
    /scheduled[\s\S]{0,300}ctx\.waitUntil\(Promise\.all\(\[sweepAndDispatch\(\),\s*sweepAndDispatchEventAiArtifacts\(\)\]\)\)/,
    "the scheduled recovery path must continue sweeping stale leases",
  );
});

test("verdict retries use a persisted idempotency key and replay one result", async () => {
  const schema = await read("db/schema.ts");
  const verdicts = await read("lib/server/db/verdict-repository.ts");
  const client = await read("app/api-client.ts");
  const replayTable = schema.slice(
    schema.indexOf("export const mutationReplays"),
    schema.indexOf("export const projects"),
  );
  const verdictClient = client.slice(
    client.indexOf("async saveVerdict"),
    client.indexOf("async confirmScenario"),
  );

  assert.match(replayTable, /idempotencyKey:\s*text\("idempotency_key"\)/i, "mutation idempotency must be persisted in D1");
  assert.match(
    replayTable,
    /uniqueIndex\([^)]*\)[\s\S]{0,240}workspaceId[\s\S]{0,120}actorId[\s\S]{0,120}endpointScope[\s\S]{0,120}idempotencyKey/i,
    "replay keys must be unique within workspace, actor, and endpoint scope",
  );
  assert.match(verdicts, /findMutationReplay[\s\S]{0,500}mutationReplayStatement/i, "verdict repository must replay an existing keyed result");
  assert.match(verdictClient, /idempotency-key/i, "verdict write requests must send Idempotency-Key");
});

test("frontend never auto-retains evidence for a factual edit and reuses extraction retry keys", async () => {
  const client = await read("app/api-client.ts");
  const page = uiSource;
  const verdictClient = client.slice(
    client.indexOf("async saveVerdict"),
    client.indexOf("async batchConfirm"),
  );
  const extractionHandler = page.slice(
    page.indexOf("onStart={async"),
    page.indexOf("onReview=", page.indexOf("onStart={async")),
  );

  assert.doesNotMatch(
    verdictClient,
    /retain_existing_evidence\s*:\s*true/,
    "factual edits must make evidence retention or replacement an explicit user decision",
  );
  assert.match(verdictClient, /action\s*===\s*["']edit["']\s*&&\s*!input\.edit/);
  assert.match(verdictClient, /normalized_value:\s*edit!\.normalizedValue/);
  assert.match(verdictClient, /uncertainty:\s*edit!\.uncertainty/);
  assert.match(verdictClient, /retain_relation_ids:\s*edit!\.retainRelationIds/);
  assert.match(page, /这条记录与旧记录的关系[\s\S]*?只勾选修改后仍然成立的关系/);
  assert.match(page, /verified\s*&&\s*!edit[\s\S]*?修改已确认记录/);
  assert.match(page, /记录类型[\s\S]*?<select[\s\S]*?occurrenceClaimTypeOptions/);
  assert.match(page, /editHasSupportingEvidence[\s\S]*?direct[\s\S]*?corroborating/);
  assert.doesNotMatch(
    extractionHandler,
    /startExtraction\([^)]*crypto\.randomUUID\(\)/s,
    "a retry of the same extraction request must reuse its idempotency key",
  );
});

test("claim review stays locked until the exact complete evidence set is loaded", async () => {
  const readinessHelper = declarationSource("isCompleteEvidenceSet");
  const evidenceLoader = declarationSource("openClaim");
  const verdictHandler = declarationSource("runVerdict");
  const claimScreen = declarationSource("ClaimScreen");

  assert.match(readinessHelper, /!everyFetchSucceeded/,
    "one failed Evidence request must keep the Claim locked");
  assert.match(readinessHelper, /evidenceRefs\.length\s*!==\s*expectedIds\.length/,
    "the received Evidence count must exactly match the Claim Version");
  assert.match(readinessHelper, /expected\.size\s*===\s*expectedIds\.length[\s\S]*received\.size\s*===\s*evidenceRefs\.length[\s\S]*expectedIds\.every\(\(id\)\s*=>\s*received\.has\(id\)\)/,
    "duplicate, missing, substituted, or extra Evidence IDs must not become ready");
  assert.match(evidenceLoader, /fetched\.every\(\(item\)\s*=>\s*item\.status\s*===\s*["']fulfilled["']\)/);
  assert.match(evidenceLoader, /isCompleteEvidenceSet\(nextClaim\.evidenceRefIds,\s*refs,\s*everyFetchSucceeded\)/);
  assert.doesNotMatch(evidenceLoader, /setEvidenceState\(refs\.length\s*\?\s*["']ready["']/,
    "a non-empty partial response must never be treated as ready");
  assert.match(verdictHandler, /\(action\s*===\s*["']confirm["']\s*\|\|\s*action\s*===\s*["']edit["']\)[\s\S]{0,120}evidenceState\s*!==\s*["']ready["']/,
    "event handlers must guard confirm and edit in addition to disabled buttons");
  assert.doesNotMatch(claimScreen, /批量处理选项|evidence-review-attestation/,
    "the simplified review detail must not expose a second batch-attestation workflow");
  assert.match(claimScreen, /证据未完整加载[\s\S]*确认、核对声明和修改功能已停用/);
  assert.match(claimScreen, /const evidenceReady\s*=\s*evidenceState\s*===\s*["']ready["']/);
  assert.match(claimScreen, /disabled=\{Boolean\(busy\)\s*\|\|\s*verdictLocked\s*\|\|\s*!evidenceReady\}[\s\S]{0,160}修改后确认/);
  assert.match(claimScreen, /type=["']checkbox["']\s+disabled=\{!evidenceReady\}/,
    "Evidence selection for an edit must remain disabled on a partial load");
});

test("frontend preserves creation keys until the server returns and resumes multi-step uploads", async () => {
  const client = await read("app/api-client.ts");
  const page = uiSource;
  const clientMethods = [
    ["createProject", "getProject"],
    ["createEvent", "getEvent"],
    ["beginTranscriptImport", "uploadTranscriptItem"],
    ["initAsset", "uploadAsset"],
  ];
  for (const [method, nextMethod] of clientMethods) {
    const section = client.slice(
      client.indexOf(`async ${method}`),
      client.indexOf(`async ${nextMethod}`, client.indexOf(`async ${method}`)),
    );
    assert.match(section, /idempotencyKey\s*:\s*string/,
      `${method} must require a caller-owned stable key`);
    assert.match(section, /headers\s*:\s*\{\s*["']idempotency-key["']\s*:\s*idempotencyKey\s*\}/i,
      `${method} must send its key to the API`);
  }
  for (const call of ["createProject", "createEvent"]) {
    assert.match(
      page,
      new RegExp(`mutationKeys\\.current\\.set\\(fingerprint, idempotencyKey\\)[\\s\\S]{0,500}api\\.${call}\\([\\s\\S]{0,500}mutationKeys\\.current\\.delete\\(fingerprint\\)`, "i"),
      `${call} must keep its key on failure and clear it only after a server response`,
    );
  }
  assert.match(
    page,
    /mutationKeys\.current\.set\(fingerprint, idempotencyKey\)[\s\S]{0,3500}initializeAssetUploadWithReplayRecovery\([\s\S]{0,5500}mutationKeys\.current\.delete\(fingerprint\)/i,
    "Asset init must keep its key through replay recovery, byte upload, and finalize",
  );
  assert.match(
    page,
    /!finalizeStarted && pendingAssetInit && \(initializedAssetId \|\| initCouldHaveCommitted\)[\s\S]{0,240}recoverAndAbortAssetUpload\(pendingAssetInit, initializedAssetId\)[\s\S]{0,240}uploadFingerprint && !finalizeStarted && cleanupResolved/i,
    "an ambiguous Asset init must recover the idempotent server row before clearing its key",
  );
  assert.match(
    page,
    /importCreateKeys\.current\.set\(fingerprint, idempotencyKey\)[\s\S]{0,500}api\.beginTranscriptImport\([\s\S]{0,300}importCreateKeys\.current\.delete\(fingerprint\)[\s\S]{0,200}activeSession\.current\s*=\s*\{\s*fingerprint,\s*session\s*\}/i,
    "Transcript Import must retain the create key until a session exists and cache that session for upload/finalize retries",
  );
  const importModalStart = page.indexOf("function ImportModal");
  const resumeSessionAt = page.indexOf("activeSession.current?.fingerprint === fingerprint", importModalStart);
  const uploadItemAt = page.indexOf("api.uploadTranscriptItem", resumeSessionAt);
  const finalizeImportAt = page.indexOf("api.finalizeTranscriptImport", uploadItemAt);
  assert.ok(
    importModalStart >= 0
      && resumeSessionAt > importModalStart
      && uploadItemAt > resumeSessionAt
      && finalizeImportAt > uploadItemAt,
    "a retry after partial transcript upload must reuse the existing server-side import session",
  );
});

test("frontend consumes the canonical evidence and deterministic view contracts", async () => {
  const client = await read("app/api-client.ts");
  const page = uiSource;
  const evidenceNormalizer = client.slice(
    client.indexOf("function normalizeEvidence"),
    client.indexOf("export function normalizeClaim"),
  );
  const scenarioClient = client.slice(
    client.indexOf("async confirmScenario"),
    client.indexOf("async getView"),
  );

  for (const field of ["quote_raw", "start_ms", "end_ms", "asset_view_url", "evidence_role"]) {
    assert.match(
      evidenceNormalizer,
      new RegExp(`\\b${field}\\b`),
      `canonical evidence field ${field} must survive the API adapter`,
    );
  }
  assert.match(
    scenarioClient,
    /idempotency-key/i,
    "scenario confirmation must satisfy the server mutation contract",
  );
  for (const field of [
    "currentClaims",
    "recentDeltas",
    "deltas",
    "contradictions",
    "missingSlots",
    "stateClaimId",
    "deltaItemIds",
    "agendaItemIds",
    "openedAt",
    "repeatCount",
  ]) {
    assert.match(
      page,
      new RegExp(`\\b${field}\\b`),
      `deterministic view field ${field} needs an explicit UI path`,
    );
  }
});

test("Brief Card resolves deterministic IDs into readable source content", async () => {
  const loader = declarationSource("loadBriefDisplayData");
  const briefRenderer = ["briefItemText", "briefSourceId", "BriefGroup"]
    .map(declarationSource)
    .join("\n");

  assert.match(loader, /loadVerifiedView:[\s\S]*?api\.getView\(id, view\)/,
    "Brief Card's injectable cached loader must still default to the canonical View API");
  for (const view of ["brief-card", "folder-summary", "next-meeting-agenda"]) {
    assert.match(loader, new RegExp(`loadVerifiedView\\(projectId, ["']${view}["']\\)`),
      `Brief Card must read the existing ${view} endpoint through the cached loader`);
  }
  for (const idField of ["stateClaimId", "riskClaimId", "deltaItemIds", "agendaItemIds"]) {
    assert.match(loader, new RegExp(`\\b${idField}\\b`),
      `Brief Card must preserve the canonical ${idField} mapping`);
  }
  for (const contentField of ["statement", "displayText", "sourceStatement", "targetStatement", "slot"]) {
    assert.match(briefRenderer, new RegExp(`["']${contentField}["']`),
      `Brief Card must expose human-readable ${contentField} content`);
  }
  assert.match(briefRenderer, /onOpenClaim\(sourceId\)/,
    "claim-backed Brief items must still open their evidence source");
  assert.match(briefRenderer, /onSelect\(sourceTab\)/,
    "gap and aggregate Brief items must still open their deterministic source view");
  assert.doesNotMatch(briefRenderer, /项。可从左侧对应页面查看完整内容/,
    "Brief Card must not replace the actual content with an item count");
});

test("success and error envelopes always expose the same request id", async () => {
  const api = await read("lib/server/http/api.ts");
  assert.match(api, /ApiSuccess<[^>]+>[\s\S]{0,120}request_id\s*:\s*id/);
  assert.match(api, /ApiErrorResponse[\s\S]{0,300}request_id\s*:\s*id/);
  assert.match(api, /["']x-request-id["']\s*:\s*id/);
  assert.doesNotMatch(api, /stack\s*:/i);
});

test("browser source and built client contain no model credentials", async () => {
  const browserFiles = [
    ...(await collectFiles("app")),
    ...((await exists("dist/client")) ? await collectFiles("dist/client") : []),
  ].filter((path) => /\.(ts|tsx|js|jsx|html|json)$/.test(path));
  const source = (await Promise.all(browserFiles.map(read))).join("\n");

  assert.doesNotMatch(source, /\bAI_API_KEY\b|\bOPENAI_API_KEY\b|\bANTHROPIC_API_KEY\b|\bGEMINI_API_KEY\b/);
  assert.doesNotMatch(source, /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/);
  assert.doesNotMatch(source, /Authorization\s*:\s*["'`]Bearer\s+[A-Za-z0-9._-]{12,}/i);
});

test("production scheduling is non-empty and missing APP_ENV fails closed", async () => {
  const productionConfig = JSON.parse(await read("wrangler.jsonc"));
  const context = await read("lib/server/http/context.ts");
  const route = await read("app/api/v1/[...segments]/route.ts");
  const worker = await read("worker/index.ts");
  const transcriptionOutbox = await read("lib/server/jobs/transcription-outbox.ts");
  const client = await read("app/api-client.ts");
  const localAudioBranchStart = worker.indexOf('} else if (env.APP_ENV === "local")');
  const productionAudioBranchStart = worker.indexOf("} else {", localAudioBranchStart);
  const productionAudioBranchEnd = worker.indexOf("return dispatchResponse", productionAudioBranchStart);
  assert.ok(
    localAudioBranchStart >= 0 &&
      productionAudioBranchStart > localAudioBranchStart &&
      productionAudioBranchEnd > productionAudioBranchStart,
    "the Worker must keep explicit local and production transcription branches",
  );
  const localAudioBranch = worker.slice(localAudioBranchStart, productionAudioBranchStart);
  const productionAudioBranch = worker.slice(productionAudioBranchStart, productionAudioBranchEnd);

  assert.ok(
    Array.isArray(productionConfig.triggers?.crons) &&
      productionConfig.triggers.crons.some((value) => typeof value === "string" && value.trim()),
    "the production Worker must ship a non-empty cron schedule for sweep/dispatch",
  );
  assert.match(
    context,
    /bindings\.APP_ENV\s*===\s*["']local["']\s*\?\s*["']local["']\s*:\s*["']production["']/,
    "only an explicit local APP_ENV may enable development identity",
  );
  assert.match(
    route,
    /if\s*\(getBindings\(\)\.APP_ENV\s*===\s*["']local["']\)\s*return;[\s\S]*?State changes require a same-origin browser request/i,
    "missing or misspelled APP_ENV must retain production write-origin checks",
  );
  assert.match(worker, /url\.pathname === ["']\/api\/v1\/jobs\/dispatch["']/);
  assert.match(worker, /oai-authenticated-user-id/);
  assert.match(worker, /sec-fetch-site["']\) === ["']same-origin["']/);
  assert.match(worker, /scheduled[\s\S]{0,300}ctx\.waitUntil\(Promise\.all\(\[sweepAndDispatch\(\),\s*sweepAndDispatchEventAiArtifacts\(\)\]\)\)/);
  assert.match(
    worker,
    /if\s*\(env\.APP_ENV\s*!==\s*["']local["']\)[\s\S]{0,900}sameOrigin[\s\S]{0,500}authenticated/,
    "missing or misspelled APP_ENV must also retain production dispatch authentication",
  );
  assert.match(
    worker,
    /ctx\.waitUntil\(Promise\.all\(\[[\s\S]{0,300}dispatchExtractionRun\(workspaceId,\s*input\.runId\)[\s\S]{0,200}dispatchEventAiArtifactsForExtraction\(workspaceId,\s*input\.runId\)/,
    "targeted extraction and its reading artifacts may use HTTP waitUntil only for short background checkpoints",
  );
  assert.match(
    localAudioBranch,
    /ctx\.waitUntil\(dispatchTranscriptionRun\(workspaceId,\s*input\.runId\)\.catch/,
    "local development may start transcription immediately because it has no Cron trigger",
  );
  assert.match(
    productionAudioBranch,
    /return\s+streamTranscriptionDispatch\(workspaceId,\s*input\.runId,\s*requestId,\s*run\.status\)/,
    "production HTTP dispatch must stream heartbeats while processing the existing transcription Run",
  );
  assert.doesNotMatch(productionAudioBranch, /waitUntil\(dispatchTranscriptionRun/);
  assert.match(
    transcriptionOutbox,
    /wakeTranscriptionRun[\s\S]{0,360}prepareTargetedTranscriptionOutbox/,
    "the production wake must make the durable transcription outbox message due",
  );
  assert.match(worker, /run_id:\s*input\.runId[\s\S]{0,240}requestId,\s*202/);
  assert.match(client, /async kickDispatcher\(target\?/);
  assert.match(client, /["']\/api\/v1\/jobs\/dispatch["']/);
  assert.doesNotMatch(client, /kickLocalDispatcher/);
});

test("image budget defaults stay aligned from admission through processing", async () => {
  const repository = await read("lib/server/db/core-repository.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const exampleEnvironment = await read(".env.example");

  assert.match(
    repository,
    /configuredPositiveInteger\(bindings\.MAX_RUN_IMAGE_UNITS,\s*12\)/,
    "run admission must default to the documented 12-image limit",
  );
  assert.match(
    processor,
    /configuredInteger\(bindings\.MAX_RUN_IMAGE_UNITS,\s*12\)/,
    "the processor must enforce the same default image limit as admission",
  );
  assert.match(
    exampleEnvironment,
    /^MAX_RUN_IMAGE_UNITS=12$/m,
    "the example environment must document the same default image limit",
  );
});

test("test-only domain fixtures are not imported by production source", async () => {
  const productionFiles = [
    ...(await collectFiles("app")),
    ...(await collectFiles("lib")),
    ...(await collectFiles("worker")),
  ].filter((path) => /\.(ts|tsx|js|jsx)$/.test(path));
  const source = (await Promise.all(productionFiles.map(read))).join("\n");
  assert.doesNotMatch(source, /tests\/fixtures|qa-domain-fixture/);
});

test("glossary management is scoped, audited, idempotent, and context-safe", async () => {
  const repository = await read("lib/server/db/glossary-repository.ts");
  const route = await read("app/api/v1/[...segments]/route.ts");
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  const contextPack = await read("lib/domain/context-pack.ts");
  const page = uiSource;

  assert.match(
    repository,
    /JOIN projects p ON p\.id = ge\.project_id[\s\S]{0,220}p\.workspace_id = \?/,
    "glossary reads must be scoped through the owning project and workspace",
  );
  assert.match(
    repository,
    /findMutationReplay[\s\S]{0,900}mutationReplayStatement/,
    "glossary writes must persist idempotency replays",
  );
  assert.match(
    repository,
    /INSERT INTO mutation_guards/,
    "glossary writes must create an atomic mutation guard",
  );
  assert.match(
    repository,
    /WHERE ge\.id = \? AND ge\.version = \? AND ge\.deleted_at IS NULL/,
    "glossary updates must bind their mutation guard to the expected entry version",
  );
  assert.match(
    repository,
    /INSERT INTO glossary_entry_audits/,
    "every glossary mutation must append an audit row",
  );
  assert.match(
    repository,
    /context_version = context_version \+ 1/,
    "a glossary change must invalidate future Context Packs",
  );
  assert.match(route, /projects["']\s*&&\s*segments\[2\]\s*===\s*["']glossary/);
  assert.match(route, /request\.method === ["']DELETE["']/);
  assert.match(route, /idempotencyKey\(request\)/);
  assert.match(
    processor,
    /ge\.is_active = 1 AND ge\.deleted_at IS NULL[\s\S]{0,700}c\.review_status = 'verified'[\s\S]{0,250}c\.lifecycle_status <> 'withdrawn'/,
    "inactive, deleted, or unverified claim-derived glossary entries must not enter model context",
  );
  assert.match(
    contextPack,
    /entry\.sourceKind === ["']manual["'][\s\S]{0,180}allowedVersionIds\.has/,
    "manual entries are explicit user configuration while claim-derived entries retain the verified-only gate",
  );
  for (const label of ["词汇表", "正确写法", "常见变体", "停用", "删除"]) {
    assert.match(page, new RegExp(label), `glossary UI is missing ${label}`);
  }
});

test("Project and Event review counts stay separate from verified-only views", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const records = await read("lib/server/db/records.ts");
  const types = await read("lib/shared/api-types.ts");
  const views = await read("lib/domain/views.ts");
  const page = uiSource;

  assert.match(types, /\bevent_count\b/, "Project API types must expose the Event count");
  assert.match(records, /event_count:\s*integer\(row, ["']event_count["']\)/, "Project records must map the Event count");
  assert.match(core, /events e[\s\S]{0,160}e\.project_id = p\.id[\s\S]{0,120}AS event_count/, "Project queries must count scoped Events");
  assert.match(await read("app/api-client.ts"), /["']material_status["']/, "Event status must read the API material_status field");

  for (const field of ["pending_claim_count", "pending_occurrence_count"]) {
    assert.match(types, new RegExp(`\\b${field}\\b`), `API types must expose ${field}`);
    assert.match(records, new RegExp(`integer\\(row, ["']${field}["']\\)`), `record mapping must expose ${field}`);
  }
  assert.match(
    core,
    /c\.review_status = 'pending' AND c\.lifecycle_status = 'active'/,
    "pending Claim counts must exclude rejected, verified, and inactive records",
  );
  assert.match(
    core,
    /claim_occurrence_candidates occ[\s\S]{0,220}occ\.status = 'pending'/,
    "occurrence counts must include only pending candidates",
  );
  assert.match(
    core,
    /latest\.active_run_id = c\.extraction_run_id/,
    "Project review counts must not expose stale pending Claims from older Runs",
  );
  assert.match(
    core,
    /latest\.active_run_id = occ\.extraction_run_id/,
    "Project review counts must not expose stale occurrences from older Runs",
  );
  assert.match(
    core,
    /c\.event_id = e\.id[\s\S]{0,180}c\.extraction_run_id = e\.active_run_id/,
    "Event pending Claim counts must be scoped to the current active Run",
  );
  assert.match(
    core,
    /occ\.event_id = e\.id[\s\S]{0,180}occ\.extraction_run_id = e\.active_run_id/,
    "Event pending occurrence counts must be scoped to the current active Run",
  );
  assert.match(core, /c\.project_id = p\.id AND c\.workspace_id = p\.workspace_id/);
  assert.match(core, /c\.event_id = e\.id AND c\.workspace_id = e\.workspace_id/);
  assert.match(
    views,
    /readableEventSummary[\s\S]{0,500}lifecycleStatus !== ["']withdrawn["'][\s\S]{0,500}sort\(byImportanceThenTime\)[\s\S]{0,120}slice\(0, 2\)/,
    "Timeline summary must be deterministic, bounded, and exclude withdrawn history",
  );
  assert.doesNotMatch(
    views,
    /条已确认记录，.*条高优先级/,
    "Timeline must not fall back to count-only summaries",
  );
  assert.match(page, /还有 \{pendingReviewCount\} 条待核对/);
  assert.match(page, /尚未进入本页结果/);
  assert.match(
    page,
    /runComplete\.has\(latest\.status\)[\s\S]{0,500}await loadClaimsForRun\(latest\.id\)/,
    "terminal Run polling must refresh Project scenario state and Event review counts",
  );
  assert.match(
    page,
    /Promise\.all\(\[[\s\S]{0,180}api\.getProject\(projectId\)[\s\S]{0,100}api\.getEvent\(eventId\)[\s\S]{0,180}pollIsCurrent\(\)[\s\S]{0,220}setProject\(refreshedProject\)[\s\S]{0,100}setEvent\(refreshedEvent\)[\s\S]{0,100}setRun\(latest\)/,
    "terminal Run Project, Event, and Run refreshes must be fenced and committed together",
  );
  assert.match(page, /pendingClaimCount \+ event\.pendingOccurrenceCount/);
  assert.doesNotMatch(page, /accept=\{`[^`]*\.pdf/);
  assert.match(
    page,
    /function goSimple\(\)[\s\S]{0,350}event\?\.projectId === project\.id[\s\S]{0,180}loadSimpleProject\(project\.id, preferredEventId\)/,
    "switching from advanced tools must reload a Project-consistent Event before showing the core flow",
  );
});

test("manual Claim relations are scoped, atomic, idempotent, and visible after confirmation", async () => {
  const repository = await read("lib/server/db/verdict-repository.ts");
  const route = await read("app/api/v1/[...segments]/route.ts");
  const client = await read("app/api-client.ts");
  const page = uiSource;

  assert.match(route, /segments\[2\] === ["']relation-targets["']/);
  assert.match(route, /segments\[0\] === ["']claim-relations["']/);
  assert.match(route, /createManualRelation\([\s\S]{0,2600}idempotencyKey\(request\)/);
  assert.match(client, /listRelationTargets/);
  assert.match(client, /createManualRelation/);
  assert.match(
    repository,
    /c\.review_status = 'verified' AND c\.lifecycle_status = 'active'/,
    "manual relation targets must be current verified records",
  );
  assert.match(
    repository,
    /String\(source\.current_version_id\) === input\.source_claim_version_id[\s\S]{0,420}String\(target\.current_version_id\) === input\.target_claim_version_id/,
    "both relation endpoints must stay pinned to the reviewed Claim versions",
  );
  assert.match(
    repository,
    /Number\(project\.context_version\) !== input\.base_context_version/,
    "a stale project context must not accept a new relation",
  );
  assert.match(
    repository,
    /input\.type === ["']resolves["'][\s\S]{0,300}\["open_question", "risk", "concern", "requirement"\]/,
    "resolve must only close a genuine open or uncertain record",
  );
  assert.match(repository, /findMutationReplay[\s\S]{0,500}endpointScope[\s\S]{0,500}idempotencyKey/);
  assert.match(
    repository,
    /await db\.batch\(\[[\s\S]{0,3000}INSERT INTO claim_relations[\s\S]{0,1800}INSERT INTO relation_verdicts[\s\S]{0,1800}lifecycleRecalculationStatements[\s\S]{0,1200}ledger_version = ledger_version \+ 1/,
    "relation, audit verdict, lifecycle, and ledger update must commit together",
  );
  assert.match(page, /activeRelations = claim\.relationsForReview\.filter/);
  assert.match(page, /已经生效/);
  assert.match(page, /再关联一条旧记录/);
  for (const label of ["解决了旧问题", "取代了旧记录", "参考了旧记录", "互相冲突"]) {
    assert.match(page, new RegExp(label), `manual relation UI is missing ${label}`);
  }
});

test("AI draft stays outside the ledger and human missed facts require canonical Transcript evidence", async () => {
  const repository = await read("lib/server/db/ai-draft-repository.ts");
  const route = await read("app/api/v1/[...segments]/route.ts");
  const client = await read("app/api-client.ts");
  const page = uiSource;

  assert.match(route, /segments\[2\] === ["']draft-assessment["']/);
  assert.match(route, /segments\[2\] === ["']transcript-segments["']/);
  assert.match(route, /segments\[2\] === ["']manual-claims["']/);
  assert.match(client, /recordAiDraftAssessment/);
  assert.match(client, /createManualClaim/);
  assert.match(
    repository,
    /INSERT INTO ai_draft_assessments/,
    "draft usability must be stored separately from Claim verification",
  );
  assert.doesNotMatch(
    repository,
    /assessment[\s\S]{0,300}review_status = 'verified'/,
    "a positive draft assessment must never verify AI Claims",
  );
  assert.match(
    repository,
    /text_segments[\s\S]{0,450}workspace_id = \?[\s\S]{0,150}project_id = \?[\s\S]{0,150}event_id = \?/,
    "manual missed facts must select Event-scoped canonical Transcript segments",
  );
  assert.match(repository, /review_status[\s\S]{0,300}'pending'/);
  assert.match(repository, /source[\s\S]{0,300}'human'/);
  assert.match(repository, /structural_validation_status[\s\S]{0,180}'valid'/);
  for (const label of [
    "AI 沟通信息初稿",
    "这份初稿基本可用",
    "AI 漏掉了重要信息",
    "核对重要内容",
    "本轮确认完成",
  ]) {
    assert.match(page, new RegExp(label), `guided draft UI is missing ${label}`);
  }
});
