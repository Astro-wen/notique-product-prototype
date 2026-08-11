import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  matchesFrozenOccurrenceTarget,
  matchesRejectableOccurrenceTarget,
  OCCURRENCE_FROZEN_TARGET_PREDICATE_SQL,
  OCCURRENCE_REJECTABLE_TARGET_PREDICATE_SQL,
} from "../lib/domain/occurrence-conversion.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("occurrence conversion is an explicit bounded API contract", async () => {
  const [contract, route] = await Promise.all([
    read("lib/shared/api-types.ts"),
    read("app/api/v1/[...segments]/route.ts"),
  ]);
  assert.match(contract, /action:\s*"convert_to_new_claim"[\s\S]{0,180}new_claims:/);
  assert.match(contract, /status:\s*"confirm"\s*\|\s*"reject"\s*\|\s*"converted"/);
  assert.match(contract, /converted_claims:\s*ClaimRecord\[\]/);
  assert.match(route, /new_claims\.length\s*<\s*1\s*\|\|\s*body\.new_claims\.length\s*>\s*10/);
  assert.match(route, /new_claims\[\$\{index\}\]\.statement[\s\S]{0,260}CLAIM_TYPES/);
  assert.match(route, /new Set\(newClaims\.map[\s\S]{0,180}duplicate records/);
});

test("conversion creates pending claims atomically and leaves the target claim untouched", async () => {
  const repository = await read("lib/server/db/verdict-repository.ts");
  const section = repository.slice(
    repository.indexOf("export async function applyOccurrenceVerdict"),
    repository.indexOf("export async function resolveContradiction"),
  );
  assert.doesNotMatch(section, /Conversion requires an extracted new-claim payload/);
  assert.match(section, /schema_version:\s*"occurrence-evidence\.v1"/);
  assert.match(section, /input\.action === "confirm" \|\| input\.action === "convert_to_new_claim"/);
  assert.match(
    section,
    /INSERT INTO claims[\s\S]{0,700}'pending', 'active'[\s\S]{0,180}'occurrence_conversion'/,
  );
  assert.match(
    section,
    /INSERT INTO claim_versions[\s\S]{0,300}'human'[\s\S]{0,500}INSERT INTO evidence_refs/,
  );
  assert.match(section, /claim_version_id[\s\S]{0,900}converted\.versionId/);
  assert.match(section, /UPDATE claim_occurrence_candidates SET status/);
  assert.match(section, /INSERT INTO occurrence_verdicts/);
  assert.match(section, /mutationReplayStatement[\s\S]{0,180}persistedResult/);
  assert.match(section, /converted_claim_ids[\s\S]{0,180}getClaim/);

  const conversionBranch = section.slice(
    section.indexOf("const convertedClaimStatements"),
    section.indexOf("const persistedResult"),
  );
  assert.doesNotMatch(
    conversionBranch,
    /UPDATE claims[\s\S]{0,200}candidate\.target_claim_id/,
    "conversion must not mutate the verified target claim",
  );
});

test("a frozen occurrence cannot be revived with a newer target version", async () => {
  const repository = await read("lib/server/db/verdict-repository.ts");
  const section = repository.slice(
    repository.indexOf("export async function applyOccurrenceVerdict"),
    repository.indexOf("export async function resolveContradiction"),
  );
  assert.match(section, /matchesFrozenOccurrenceTarget\(occurrenceTarget,/);
  assert.match(section, /:\s*OCCURRENCE_FROZEN_TARGET_PREDICATE_SQL/);
  assert.match(
    section,
    /input\.targetBaseVersionId,\s*input\.targetBaseVersionId,/,
    "the D1 guard must bind the request to both frozen candidate version columns",
  );

  const frozen = {
    status: "pending",
    baseVersionId: "cv-1",
    targetClaimVersionId: "cv-1",
    currentVersionId: "cv-1",
    reviewStatus: "verified",
    lifecycleStatus: "active",
  };
  assert.equal(matchesFrozenOccurrenceTarget(frozen, "cv-1"), true);
  assert.equal(
    matchesFrozenOccurrenceTarget({ ...frozen, currentVersionId: "cv-2" }, "cv-2"),
    false,
    "changing the request to the edited version must not revive old evidence",
  );
  assert.equal(
    matchesFrozenOccurrenceTarget({ ...frozen, targetClaimVersionId: "cv-2" }, "cv-1"),
    false,
    "candidate base and frozen target must be identical",
  );

  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        current_version_id TEXT NOT NULL,
        review_status TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL
      );
      CREATE TABLE claim_occurrence_candidates (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_claim_id TEXT NOT NULL,
        base_version_id TEXT NOT NULL,
        target_claim_version_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO claims VALUES ('claim-1', 'cv-1', 'verified', 'active');
      INSERT INTO claim_occurrence_candidates
        VALUES ('candidate-1', 'workspace-1', 'claim-1', 'cv-1', 'cv-1', 'pending');
    `);
    const guard = db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM claim_occurrence_candidates occ
        JOIN claims c ON c.id = occ.target_claim_id
        WHERE occ.id = ? AND occ.workspace_id = ?
          AND ${OCCURRENCE_FROZEN_TARGET_PREDICATE_SQL}
      ) AS allowed
    `);
    assert.equal(
      Number(guard.get("candidate-1", "workspace-1", "cv-1", "cv-1").allowed),
      1,
    );

    db.exec("UPDATE claims SET current_version_id = 'cv-2' WHERE id = 'claim-1'");
    assert.equal(
      Number(guard.get("candidate-1", "workspace-1", "cv-2", "cv-2").allowed),
      0,
      "passing the edited version cannot reuse the candidate's cv-1 evidence",
    );
    assert.equal(
      Number(guard.get("candidate-1", "workspace-1", "cv-1", "cv-1").allowed),
      0,
      "the frozen version also fails after the target claim has moved on",
    );
  } finally {
    db.close();
  }
});

test("reject can close a stale occurrence without reviving its frozen target", async () => {
  const repository = await read("lib/server/db/verdict-repository.ts");
  const section = repository.slice(
    repository.indexOf("export async function applyOccurrenceVerdict"),
    repository.indexOf("export async function resolveContradiction"),
  );
  assert.match(
    section,
    /input\.action === "reject"[\s\S]{0,180}matchesRejectableOccurrenceTarget/,
    "reject must use the pending-candidate version gate",
  );
  assert.match(
    section,
    /input\.action === "reject"[\s\S]{0,180}OCCURRENCE_REJECTABLE_TARGET_PREDICATE_SQL/,
    "the atomic D1 guard must use the same reject-only gate",
  );
  assert.match(
    section,
    /:\s*matchesFrozenOccurrenceTarget\(occurrenceTarget,[\s\S]{0,80}targetBaseVersionId\)/,
    "confirm and conversion must retain the strict frozen-target gate",
  );

  const stale = {
    status: "pending",
    baseVersionId: "cv-1",
    targetClaimVersionId: "cv-1",
  };
  assert.equal(matchesRejectableOccurrenceTarget(stale, "cv-1"), true);
  assert.equal(
    matchesRejectableOccurrenceTarget(stale, "cv-2"),
    false,
    "the caller cannot substitute the target's newer version",
  );
  assert.equal(
    matchesRejectableOccurrenceTarget({ ...stale, targetClaimVersionId: "cv-2" }, "cv-1"),
    false,
    "both frozen candidate columns must match the request",
  );
  assert.equal(
    matchesRejectableOccurrenceTarget({ ...stale, status: "confirmed" }, "cv-1"),
    false,
    "only a pending candidate can be rejected",
  );

  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        current_version_id TEXT NOT NULL,
        review_status TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL
      );
      CREATE TABLE claim_occurrence_candidates (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_claim_id TEXT NOT NULL,
        base_version_id TEXT NOT NULL,
        target_claim_version_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO claims VALUES ('claim-1', 'cv-2', 'verified', 'superseded');
      INSERT INTO claim_occurrence_candidates
        VALUES ('candidate-1', 'workspace-1', 'claim-1', 'cv-1', 'cv-1', 'pending');
    `);
    const rejectGuard = db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM claim_occurrence_candidates occ
        JOIN claims c ON c.id = occ.target_claim_id
        WHERE occ.id = ? AND occ.workspace_id = ?
          AND ${OCCURRENCE_REJECTABLE_TARGET_PREDICATE_SQL}
      ) AS allowed
    `);
    assert.equal(
      Number(rejectGuard.get("candidate-1", "workspace-1", "cv-1", "cv-1").allowed),
      1,
      "a pending candidate remains rejectable after its target was revised and superseded",
    );
    assert.equal(
      Number(rejectGuard.get("candidate-1", "workspace-1", "cv-2", "cv-2").allowed),
      0,
      "the newer target version cannot be supplied to reject stale candidate evidence",
    );
    db.exec("UPDATE claim_occurrence_candidates SET status = 'confirmed'");
    assert.equal(
      Number(rejectGuard.get("candidate-1", "workspace-1", "cv-1", "cv-1").allowed),
      0,
      "the atomic guard closes after another verdict wins",
    );
  } finally {
    db.close();
  }
});

test("review UI can split a mistaken reaffirmation into pending records", async () => {
  const [client, page] = await Promise.all([
    read("app/api-client.ts"),
    read("app/page.tsx"),
  ]);
  assert.match(client, /convertOccurrenceToClaims[\s\S]{0,900}convert_to_new_claim/);
  assert.match(client, /result\.status !== "converted"/);
  assert.match(client, /result\.converted_claims\.length !== newClaims\.length/);
  assert.match(page, /每行写一条记录/);
  assert.match(page, /原记录不会被修改/);
  assert.match(page, /生成 \$\{statements\.length \|\| 0\} 条待审核记录/);
  assert.match(page, /runOccurrenceConversion[\s\S]{0,900}loadReviewQueue/);
});
