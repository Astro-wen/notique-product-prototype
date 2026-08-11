import {
  confirmScenario,
  createEvent,
  createExtractionRun,
  createProject,
  createTranscriptImport,
  debugRun,
  finalizeAsset,
  finalizeTranscriptImport,
  getAsset,
  getAssetEvidenceObject,
  getClaimHistory,
  getEvent,
  getEvidenceRef,
  getExtractionRun,
  getProject,
  getRunClaims,
  initializeAsset,
  listEvents,
  listProjects,
  uploadAssetContent,
  uploadTranscriptImportItem,
} from "@/lib/server/db/core-repository";
import {
  buildProjectAgenda,
  buildProjectBrief,
  buildProjectGapCheck,
  buildProjectView,
} from "@/lib/server/db/ledger-repository";
import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  listGlossaryEntries,
  updateGlossaryEntry,
} from "@/lib/server/db/glossary-repository";
import {
  applyBatchVerdicts,
  applyClaimVerdict,
  applyOccurrenceVerdict,
  attestClaimEvidenceReview,
  createManualRelation,
  getClaim,
  listManualRelationTargets,
  resolveContradiction,
  withdrawClaim,
} from "@/lib/server/db/verdict-repository";
import {
  createTranscriptionRun,
  getTranscriptionRun,
} from "@/lib/server/db/transcription-repository";
import {
  completeReviewSession,
  getReviewSession,
  startReviewSession,
} from "@/lib/server/db/review-session-repository";
import {
  ApiFault,
  enumValue,
  isoDate,
  jsonObject,
  nonNegativeInteger,
  ok,
  optionalString,
  requestId,
  requiredString,
  stringArray,
  toResponse,
} from "@/lib/server/http/api";
import { getRequestScope } from "@/lib/server/http/context";
import { planByteRangeResponse } from "@/lib/server/http/byte-range";
import type {
  BatchClaimVerdictRequest,
  ClaimVerdictRequest,
  OccurrenceConversionClaimInput,
  OccurrenceVerdictRequest,
} from "@/lib/shared/api-types";
import { getBindings } from "@/db";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ segments: string[] }> };
type JsonRecord = Record<string, unknown>;

const EVENT_TYPES = ["meeting", "showing", "estimate", "walkthrough"] as const;
const ASSET_KINDS = ["transcript", "photo", "pdf", "text", "audio"] as const;
const CLAIM_TYPES = [
  "budget",
  "preference",
  "requirement",
  "decision",
  "concern",
  "risk",
  "open_question",
  "person_role",
  "timing",
  "property_fact",
  "material",
  "measurement",
  "other",
] as const;
const RELATION_TYPES = ["supersedes", "contradicts", "resolves", "informed_by"] as const;
const VIEW_TYPES = [
  "folder-summary",
  "timeline",
  "decisions",
  "preferences",
  "open-questions",
  "risks",
] as const;
const GLOSSARY_CATEGORIES = [
  "general",
  "person",
  "company",
  "industry_term",
  "material",
  "property",
] as const;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} must be an object.`, { field });
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown, field: string): JsonRecord {
  if (value === undefined || value === null) return {};
  return record(value, field);
}

function positiveInteger(value: unknown, field: string, max: number): number {
  const result = nonNegativeInteger(value, field);
  if (result < 1 || result > max) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} is outside the allowed range.`, {
      field,
      min: 1,
      max,
    });
  }
  return result;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiFault(400, "BAD_REQUEST", `${field} must be a boolean.`, { field });
  }
  return value;
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw new ApiFault(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required for this write.",
    );
  }
  if (value.length > 200) {
    throw new ApiFault(400, "BAD_REQUEST", "Idempotency-Key is too long.");
  }
  return value;
}

function enforceSameOriginWrite(request: Request): void {
  if (getBindings().APP_ENV === "local") return;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || origin !== new URL(request.url).origin || fetchSite !== "same-origin") {
    throw new ApiFault(401, "UNAUTHORIZED", "State changes require a same-origin browser request.");
  }
}

function allowedTranscript(filename: string, mimeType: string): boolean {
  return (
    ["text/plain", "text/vtt", "application/json", "application/x-subrip"].includes(
      mimeType,
    ) || /\.(txt|vtt|srt|json)$/i.test(filename)
  );
}

function contentDispositionFilename(value: unknown): string {
  const filename = typeof value === "string" && value.trim() ? value.trim() : "evidence";
  return encodeURIComponent(filename).replaceAll("'", "%27").replaceAll("(", "%28").replaceAll(")", "%29");
}

function parseClaimVerdict(body: JsonRecord): ClaimVerdictRequest {
  const action = enumValue(body.action, "action", ["confirm", "reject", "edit"] as const);
  const result: ClaimVerdictRequest = {
    action,
    base_version_id: requiredString(body.base_version_id, "base_version_id", { max: 128 }),
  };
  const explanation = optionalString(body.explanation, "explanation", { max: 2_000 });
  if (explanation) result.explanation = explanation;
  if (action === "confirm") {
    if (!("retain_relation_ids" in body)) {
      throw new ApiFault(
        400,
        "BAD_REQUEST",
        "retain_relation_ids must explicitly record the reviewed relationship decisions.",
      );
    }
    result.retain_relation_ids = stringArray(
      body.retain_relation_ids,
      "retain_relation_ids",
      { max: 100 },
    );
  }
  if (action === "edit") {
    const edit = record(body.edit, "edit");
    if (!("normalized_value" in edit)) {
      throw new ApiFault(400, "BAD_REQUEST", "edit.normalized_value must be reviewed explicitly.");
    }
    if (!("uncertainty" in edit)) {
      throw new ApiFault(400, "BAD_REQUEST", "edit.uncertainty must be reviewed explicitly.");
    }
    if (typeof edit.needs_additional_evidence !== "boolean") {
      throw new ApiFault(400, "BAD_REQUEST", "edit.needs_additional_evidence must be reviewed explicitly.");
    }
    const normalizedValue = edit.normalized_value;
    result.edit = {
      statement: requiredString(edit.statement, "edit.statement", { max: 10_000 }),
      type: requiredString(edit.type, "edit.type", { max: 100 }),
      normalized_value: normalizedValue as NonNullable<ClaimVerdictRequest["edit"]>["normalized_value"],
      needs_additional_evidence: edit.needs_additional_evidence,
      uncertainty: edit.uncertainty as NonNullable<ClaimVerdictRequest["edit"]>["uncertainty"],
      retain_relation_ids: stringArray(
        edit.retain_relation_ids,
        "edit.retain_relation_ids",
        { max: 100 },
      ),
      ...(edit.evidence_ref_ids === undefined
        ? {}
        : {
            evidence_ref_ids: stringArray(edit.evidence_ref_ids, "edit.evidence_ref_ids", {
              max: 100,
            }),
          }),
      retain_existing_evidence: edit.retain_existing_evidence === true,
      ...(edit.secondary_evidence_note === undefined
        ? {}
        : {
            secondary_evidence_note: requiredString(
              edit.secondary_evidence_note,
              "edit.secondary_evidence_note",
              { max: 10_000 },
            ),
          }),
    };
  }
  return result;
}

function parseOccurrenceVerdict(body: JsonRecord): OccurrenceVerdictRequest {
  const action = enumValue(body.action, "action", [
    "confirm",
    "reject",
    "convert_to_new_claim",
  ] as const);
  const targetBaseVersionId = requiredString(
    body.target_base_version_id,
    "target_base_version_id",
    { max: 128 },
  );
  if (action !== "convert_to_new_claim") {
    return { action, target_base_version_id: targetBaseVersionId };
  }
  if (!Array.isArray(body.new_claims) || body.new_claims.length < 1 || body.new_claims.length > 10) {
    throw new ApiFault(400, "BAD_REQUEST", "new_claims must contain 1 to 10 records.", {
      field: "new_claims",
      min: 1,
      max: 10,
    });
  }
  const newClaims: OccurrenceConversionClaimInput[] = body.new_claims.map((value, index) => {
    const item = record(value, `new_claims[${index}]`);
    return {
      statement: requiredString(item.statement, `new_claims[${index}].statement`, {
        max: 10_000,
      }),
      type: enumValue(item.type, `new_claims[${index}].type`, CLAIM_TYPES),
    };
  });
  if (new Set(newClaims.map((item) => `${item.type}\u0000${item.statement}`)).size !== newClaims.length) {
    throw new ApiFault(400, "BAD_REQUEST", "new_claims contains duplicate records.", {
      field: "new_claims",
    });
  }
  return {
    action,
    target_base_version_id: targetBaseVersionId,
    new_claims: newClaims,
  };
}

async function getHandler(request: Request, segments: string[], id: string): Promise<Response> {
  const scope = await getRequestScope(request);
  if (segments.length === 1 && segments[0] === "projects") {
    return ok({ projects: await listProjects(scope) }, id);
  }
  if (segments.length === 2 && segments[0] === "projects") {
    return ok({ project: await getProject(scope, segments[1]) }, id);
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "events") {
    return ok({ events: await listEvents(scope, segments[1]) }, id);
  }
  if (segments.length === 2 && segments[0] === "events") {
    return ok(await getEvent(scope, segments[1]), id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "review-session"
  ) {
    return ok({ review_session: await getReviewSession(scope, segments[1]) }, id);
  }
  if (segments.length === 2 && segments[0] === "assets") {
    return ok({ asset: await getAsset(scope, segments[1]) }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "assets" &&
    segments[2] === "evidence-view"
  ) {
    const asset = await getAsset(scope, segments[1]);
    if (!asset.version) {
      await getAssetEvidenceObject(scope, segments[1]);
      throw new ApiFault(404, "NOT_FOUND", "Stored evidence object was not found.");
    }
    const totalSize = asset.version.size_bytes;
    const rangePlan = planByteRangeResponse(request.headers.get("range"), totalSize);
    const commonHeaders = new Headers({
      "accept-ranges": rangePlan.acceptRanges,
      "cache-control": "private, no-store",
      "content-type": asset.version.mime_type || "application/octet-stream",
      "content-disposition": `inline; filename="evidence"; filename*=UTF-8''${contentDispositionFilename(asset.filename)}`,
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-request-id": id,
    });
    commonHeaders.set("content-length", String(rangePlan.contentLength));
    if (rangePlan.contentRange) commonHeaders.set("content-range", rangePlan.contentRange);
    if (rangePlan.status === 416) {
      return new Response(null, { status: 416, headers: commonHeaders });
    }
    const { object } = await getAssetEvidenceObject(scope, segments[1], rangePlan.range);
    commonHeaders.set("etag", object.httpEtag);
    return new Response(object.body, {
      status: rangePlan.status,
      headers: commonHeaders,
    });
  }
  if (segments.length === 2 && segments[0] === "extraction-runs") {
    return ok({ run: await getExtractionRun(scope, segments[1]) }, id);
  }
  if (segments.length === 2 && segments[0] === "transcription-runs") {
    return ok({ transcription_run: await getTranscriptionRun(scope, segments[1]) }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "extraction-runs" &&
    segments[2] === "claims"
  ) {
    return ok(await getRunClaims(scope, segments[1]), id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "extraction-runs" &&
    segments[2] === "debug"
  ) {
    return ok({ debug: await debugRun(scope, segments[1]) }, id);
  }
  if (segments.length === 3 && segments[0] === "claims" && segments[2] === "history") {
    const history = await getClaimHistory(scope, segments[1]);
    return ok({ history, current_claim: await getClaim(scope, segments[1]) }, id);
  }
  if (segments.length === 2 && segments[0] === "evidence-refs") {
    return ok({ evidence_ref: await getEvidenceRef(scope, segments[1]) }, id);
  }
  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[2] === "views"
  ) {
    const viewType = enumValue(segments[3], "view_type", VIEW_TYPES);
    return ok({ view: await buildProjectView(scope, segments[1], viewType) }, id);
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "gap-check") {
    return ok({ gap_check: await buildProjectGapCheck(scope, segments[1]) }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "next-meeting-agenda"
  ) {
    return ok({ agenda: await buildProjectAgenda(scope, segments[1]) }, id);
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "brief-card") {
    return ok({ brief_card: await buildProjectBrief(scope, segments[1]) }, id);
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "glossary") {
    return ok({ glossary_entries: await listGlossaryEntries(scope, segments[1]) }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "relation-targets"
  ) {
    return ok(
      { relation_targets: await listManualRelationTargets(scope, segments[1]) },
      id,
    );
  }
  throw new ApiFault(404, "NOT_FOUND", "API route was not found.");
}

async function postHandler(request: Request, segments: string[], id: string): Promise<Response> {
  const scope = await getRequestScope(request);
  if (segments.length === 1 && segments[0] === "claim-relations") {
    const body = await jsonObject(request);
    const relation = await createManualRelation(
      scope,
      {
        project_id: requiredString(body.project_id, "project_id", { max: 128 }),
        base_context_version: nonNegativeInteger(
          body.base_context_version,
          "base_context_version",
        ),
        source_claim_id: requiredString(body.source_claim_id, "source_claim_id", {
          max: 128,
        }),
        source_claim_version_id: requiredString(
          body.source_claim_version_id,
          "source_claim_version_id",
          { max: 128 },
        ),
        target_claim_id: requiredString(body.target_claim_id, "target_claim_id", {
          max: 128,
        }),
        target_claim_version_id: requiredString(
          body.target_claim_version_id,
          "target_claim_version_id",
          { max: 128 },
        ),
        type: enumValue(body.type, "type", RELATION_TYPES),
        reason: requiredString(body.reason, "reason", { min: 3, max: 2_000 }),
      },
      idempotencyKey(request),
    );
    return ok({ relation }, id, 201);
  }
  if (segments.length === 1 && segments[0] === "projects") {
    const body = await jsonObject(request);
    const project = await createProject(scope, {
      name: requiredString(body.name, "name", { max: 200 }),
      locale:
        body.locale === undefined
          ? "en-US"
          : requiredString(body.locale, "locale", { max: 35 }),
    }, idempotencyKey(request));
    return ok({ project }, id, 201);
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "glossary") {
    const body = await jsonObject(request);
    const glossaryEntry = await createGlossaryEntry(
      scope,
      segments[1],
      {
        canonical_value: requiredString(body.canonical_value, "canonical_value", { max: 120 }),
        variants: stringArray(body.variants, "variants", { max: 20 }),
        category: enumValue(body.category, "category", GLOSSARY_CATEGORIES),
      },
      idempotencyKey(request),
    );
    return ok({ glossary_entry: glossaryEntry }, id, 201);
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "scenario-verdict"
  ) {
    const body = await jsonObject(request);
    const project = await confirmScenario(
      scope,
      segments[1],
      {
        scenarioVersion: nonNegativeInteger(body.scenario_version, "scenario_version"),
        scenario: requiredString(body.scenario, "scenario", { max: 200 }),
        source: enumValue(body.source, "source", ["candidate", "manual"] as const),
      },
      idempotencyKey(request),
    );
    return ok({ project }, id);
  }
  if (segments.length === 3 && segments[0] === "projects" && segments[2] === "events") {
    const body = await jsonObject(request);
    const event = await createEvent(scope, segments[1], {
      eventType: enumValue(body.event_type, "event_type", EVENT_TYPES),
      title: requiredString(body.title, "title", { max: 300 }),
      occurredAt: isoDate(body.occurred_at, "occurred_at"),
      metadata: optionalRecord(body.metadata, "metadata"),
    }, idempotencyKey(request));
    return ok({ event }, id, 201);
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "review-sessions"
  ) {
    await jsonObject(request);
    const reviewSession = await startReviewSession(
      scope,
      segments[1],
      idempotencyKey(request),
    );
    return ok({ review_session: reviewSession }, id, 201);
  }
  if (
    segments.length === 3 &&
    segments[0] === "review-sessions" &&
    segments[2] === "complete"
  ) {
    await jsonObject(request);
    const reviewSession = await completeReviewSession(
      scope,
      segments[1],
      idempotencyKey(request),
    );
    return ok({ review_session: reviewSession }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "transcript-imports"
  ) {
    const body = await jsonObject(request);
    if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 10) {
      throw new ApiFault(400, "BAD_REQUEST", "files must contain 1 to 10 items.");
    }
    const files = body.files.map((value, index) => {
      const item = record(value, `files[${index}]`);
      const filename = requiredString(item.filename, `files[${index}].filename`, {
        max: 500,
      });
      const mimeType = requiredString(item.mime_type, `files[${index}].mime_type`, {
        max: 150,
      });
      if (!allowedTranscript(filename, mimeType)) {
        throw new ApiFault(
          415,
          "ASSET_UNSUPPORTED_FORMAT",
          "Transcript must be TXT, VTT, SRT, or JSON.",
          { filename, mime_type: mimeType },
        );
      }
      return {
        filename,
        mimeType,
        sizeBytes: positiveInteger(
          item.size_bytes,
          `files[${index}].size_bytes`,
          5 * 1024 * 1024,
        ),
      };
    });
    const transcriptImport = await createTranscriptImport(
      scope,
      segments[1],
      files,
      idempotencyKey(request),
    );
    return ok({ transcript_import: transcriptImport }, id, 201);
  }
  if (
    segments.length === 3 &&
    segments[0] === "transcript-imports" &&
    segments[2] === "finalize"
  ) {
    const body = await jsonObject(request);
    if (!Array.isArray(body.ordered_items) || body.ordered_items.length < 1 || body.ordered_items.length > 10) {
      throw new ApiFault(400, "BAD_REQUEST", "ordered_items must contain 1 to 10 items.");
    }
    const ordered = body.ordered_items.map((value, index) => {
      const item = record(value, `ordered_items[${index}]`);
      return {
        itemId: requiredString(item.item_id, `ordered_items[${index}].item_id`, {
          max: 128,
        }),
        occurredAt: isoDate(item.occurred_at, `ordered_items[${index}].occurred_at`),
        title:
          item.title === undefined
            ? `Imported transcript ${index + 1}`
            : requiredString(item.title, `ordered_items[${index}].title`, { max: 300 }),
        eventType:
          item.event_type === undefined
            ? ("meeting" as const)
            : enumValue(item.event_type, `ordered_items[${index}].event_type`, EVENT_TYPES),
      };
    });
    const result = await finalizeTranscriptImport(scope, segments[1], ordered);
    return ok(
      { transcript_import: result.transcriptImport, events: result.events },
      id,
    );
  }
  if (
    segments.length === 4 &&
    segments[0] === "events" &&
    segments[2] === "assets" &&
    segments[3] === "init"
  ) {
    const body = await jsonObject(request);
    const kind = enumValue(body.kind, "kind", ASSET_KINDS);
    const asset = await initializeAsset(scope, segments[1], {
      kind,
      filename: requiredString(body.filename, "filename", { max: 500 }),
      mimeType: requiredString(body.mime_type, "mime_type", { max: 150 }),
      // The repository applies the kind-specific byte limit so the API returns
      // ASSET_TOO_LARGE with an actionable limit instead of a generic range error.
      sizeBytes: positiveInteger(body.size_bytes, "size_bytes", Number.MAX_SAFE_INTEGER),
      ...(body.captured_at === undefined
        ? {}
        : { capturedAt: isoDate(body.captured_at, "captured_at") }),
      metadata: optionalRecord(body.metadata, "metadata"),
    }, idempotencyKey(request));
    return ok({ asset, content_url: `/api/v1/assets/${encodeURIComponent(asset.id)}/content` }, id, 201);
  }
  if (segments.length === 3 && segments[0] === "assets" && segments[2] === "finalize") {
    return ok({ asset: await finalizeAsset(scope, segments[1]) }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "assets" &&
    segments[2] === "transcription-runs"
  ) {
    const result = await createTranscriptionRun(
      scope,
      segments[1],
      idempotencyKey(request),
    );
    return ok(
      { transcription_run: result.transcriptionRun },
      id,
      result.created ? 202 : 200,
    );
  }
  if (
    segments.length === 3 &&
    segments[0] === "events" &&
    segments[2] === "extraction-runs"
  ) {
    const body = await jsonObject(request);
    const result = await createExtractionRun(
      scope,
      segments[1],
      idempotencyKey(request),
      stringArray(body.asset_version_ids, "asset_version_ids", { min: 1, max: 25 }),
    );
    return ok({ run: result.run }, id, result.created ? 202 : 200);
  }
  if (segments.length === 3 && segments[0] === "claims" && segments[2] === "verdicts") {
    const body = parseClaimVerdict(await jsonObject(request));
    const result = await applyClaimVerdict(
      scope,
      segments[1],
      body,
      idempotencyKey(request),
    );
    return ok({ claim: result.claim, verdict_id: result.verdictId }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "claims" &&
    segments[2] === "evidence-review-attestations"
  ) {
    const body = await jsonObject(request);
    const claim = await attestClaimEvidenceReview(
      scope,
      segments[1],
      requiredString(body.base_version_id, "base_version_id", { max: 128 }),
      idempotencyKey(request),
    );
    return ok({ claim }, id);
  }
  if (segments.length === 2 && segments[0] === "claims" && segments[1] === "batch-verdicts") {
    const body = await jsonObject(request);
    if (!Array.isArray(body.verdicts)) {
      throw new ApiFault(400, "BAD_REQUEST", "verdicts must be an array.");
    }
    const verdicts: BatchClaimVerdictRequest["verdicts"] = body.verdicts.map(
      (value, index) => {
        const item = record(value, `verdicts[${index}]`);
        return {
          claim_id: requiredString(item.claim_id, `verdicts[${index}].claim_id`, {
            max: 128,
          }),
          action: enumValue(item.action, `verdicts[${index}].action`, ["confirm", "reject"] as const),
          base_version_id: requiredString(
            item.base_version_id,
            `verdicts[${index}].base_version_id`,
            { max: 128 },
          ),
          ...(item.explanation === undefined
            ? {}
            : {
                explanation: requiredString(
                  item.explanation,
                  `verdicts[${index}].explanation`,
                  { max: 2_000 },
                ),
              }),
        };
      },
    );
    const results = await applyBatchVerdicts(
      scope,
      { verdicts },
      idempotencyKey(request),
    );
    return ok(
      {
        verdicts: results.map((item) => ({
          claim: item.claim,
          verdict_id: item.verdictId,
        })),
      },
      id,
    );
  }
  if (segments.length === 3 && segments[0] === "claims" && segments[2] === "withdraw") {
    const body = await jsonObject(request);
    const result = await withdrawClaim(
      scope,
      segments[1],
      {
        baseVersionId: requiredString(body.base_version_id, "base_version_id", { max: 128 }),
        ...(body.explanation === undefined
          ? {}
          : { explanation: requiredString(body.explanation, "explanation", { max: 2_000 }) }),
      },
      idempotencyKey(request),
    );
    return ok({ claim: result.claim, verdict_id: result.verdictId }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "occurrence-candidates" &&
    segments[2] === "verdicts"
  ) {
    const body = parseOccurrenceVerdict(await jsonObject(request));
    const result = await applyOccurrenceVerdict(
      scope,
      segments[1],
      {
        action: body.action,
        targetBaseVersionId: body.target_base_version_id,
        ...(body.action === "convert_to_new_claim" ? { newClaims: body.new_claims } : {}),
      },
      idempotencyKey(request),
    );
    return ok({ occurrence_verdict: result }, id);
  }
  if (
    segments.length === 3 &&
    segments[0] === "claim-relations" &&
    segments[2] === "resolve"
  ) {
    const body = await jsonObject(request);
    const result = await resolveContradiction(
      scope,
      segments[1],
      {
        baseRelationStatus: requiredString(
          body.base_relation_status,
          "base_relation_status",
          { max: 30 },
        ),
        sourceClaimVersionId: requiredString(
          body.source_claim_version_id,
          "source_claim_version_id",
          { max: 128 },
        ),
        targetClaimVersionId: requiredString(
          body.target_claim_version_id,
          "target_claim_version_id",
          { max: 128 },
        ),
        winningClaimVersionId: requiredString(
          body.winning_claim_version_id,
          "winning_claim_version_id",
          { max: 128 },
        ),
        ...(body.explanation === undefined
          ? {}
          : { explanation: requiredString(body.explanation, "explanation", { max: 2_000 }) }),
      },
      idempotencyKey(request),
    );
    return ok({ relation_verdict: result }, id);
  }
  throw new ApiFault(404, "NOT_FOUND", "API route was not found.");
}

async function putHandler(request: Request, segments: string[], id: string): Promise<Response> {
  const scope = await getRequestScope(request);
  if (segments.length === 2 && segments[0] === "glossary") {
    const body = await jsonObject(request);
    const glossaryEntry = await updateGlossaryEntry(
      scope,
      segments[1],
      {
        base_version: positiveInteger(body.base_version, "base_version", Number.MAX_SAFE_INTEGER),
        canonical_value: requiredString(body.canonical_value, "canonical_value", { max: 120 }),
        variants: stringArray(body.variants, "variants", { max: 20 }),
        category: enumValue(body.category, "category", GLOSSARY_CATEGORIES),
        is_active: booleanValue(body.is_active, "is_active"),
      },
      idempotencyKey(request),
    );
    return ok({ glossary_entry: glossaryEntry }, id);
  }
  if (
    segments.length === 5 &&
    segments[0] === "transcript-imports" &&
    segments[2] === "items" &&
    segments[4] === "content"
  ) {
    const transcriptImport = await uploadTranscriptImportItem(
      scope,
      segments[1],
      segments[3],
      request,
    );
    return ok({ transcript_import: transcriptImport }, id);
  }
  if (segments.length === 3 && segments[0] === "assets" && segments[2] === "content") {
    return ok({ asset: await uploadAssetContent(scope, segments[1], request) }, id);
  }
  throw new ApiFault(404, "NOT_FOUND", "API route was not found.");
}

async function deleteHandler(request: Request, segments: string[], id: string): Promise<Response> {
  const scope = await getRequestScope(request);
  if (segments.length === 2 && segments[0] === "glossary") {
    const body = await jsonObject(request);
    const glossaryEntry = await deleteGlossaryEntry(
      scope,
      segments[1],
      positiveInteger(body.base_version, "base_version", Number.MAX_SAFE_INTEGER),
      idempotencyKey(request),
    );
    return ok({ glossary_entry: glossaryEntry }, id);
  }
  throw new ApiFault(404, "NOT_FOUND", "API route was not found.");
}

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const id = requestId(request);
  try {
    const { segments } = await context.params;
    if (request.method === "GET") return await getHandler(request, segments, id);
    if (request.method === "POST") {
      enforceSameOriginWrite(request);
      return await postHandler(request, segments, id);
    }
    if (request.method === "PUT") {
      enforceSameOriginWrite(request);
      return await putHandler(request, segments, id);
    }
    if (request.method === "DELETE") {
      enforceSameOriginWrite(request);
      return await deleteHandler(request, segments, id);
    }
    throw new ApiFault(405, "METHOD_NOT_ALLOWED", "HTTP method is not supported.");
  } catch (error) {
    return toResponse(error, id);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
