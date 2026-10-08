import type { ContextPack } from './context-pack';
import type { ExtractClaimsOutput } from './model-contract';

type Claim = ExtractClaimsOutput['claims'][number];
type Link = {final_claim_key: string; target_draft_claim_id: string; target_draft_claim_version_id: string; reason?: string; alignment?: {same_subject: boolean; same_dimension: boolean; comparable_scope: boolean; conclusion_supported: boolean}};
export type ComparisonQualityIssue = {claimKey: string; targetVersionId?: string; reason: 'metric_unit_mismatch' | 'comparison_scope_mismatch'};

function field(value: Record<string, unknown> | null | undefined, name: string): string {
  return typeof value?.[name] === 'string' ? String(value[name]).trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function institutionFromTitle(title: string | undefined): string {
  const label = title?.split(/[·|]/)[0]?.trim() ?? '';
  return /\b(?:bank|insurance|assurance|university|hospital|corporation|corp|inc|llc|ltd)\.?$/i.test(label) ? label.toLowerCase() : '';
}

function ownsObservation(statement: string, institution: string): boolean {
  const names = [institution, institution.replace(/\s+(?:bank|insurance|assurance|university|hospital|corporation|corp|inc|llc|ltd)\.?$/i, '')];
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}(?:['’]s|\\s+(?:has|have|had|is|was|uses?|does|reported|expects?|sees?|currently|did))\\b`, 'i').test(statement);
  });
}

export function hasRateDurationMismatch(claim: Pick<Claim, 'statement' | 'normalized_value'>): boolean {
  const dimension = field(claim.normalized_value, 'comparison_dimension');
  const unit = field(claim.normalized_value, 'unit');
  if (/rate|percentage|比例|率/.test(dimension) && /^(days?|hours?|天|小时)$/.test(unit)) return true;
  // Deliberately bounded to a single rate expression. A sentence that separately
  // reports "revision rate 10%, and turnaround 2 days" remains valid.
  return /\brates?\s+(?:(?:as|of|was|is|were|are|at|by|approximately|about)\s+)*\d+(?:\.\d+)?\s+(?:additional\s+)?(?:days?|hours?)\b/i.test(claim.statement)
    || /\b\d+(?:\.\d+)?\s+(?:days?|hours?)\s+(?:higher|lower)\s+(?:revision\s+)?rates?\b/i.test(claim.statement);
}

export function comparisonQualityIssues(claims: Claim[], links: Link[], context?: ContextPack): ComparisonQualityIssue[] {
  const issues: ComparisonQualityIssue[] = claims.filter(hasRateDurationMismatch).map(claim => ({claimKey: claim.client_claim_key, reason: 'metric_unit_mismatch'}));
  if (!context) return issues;
  const byKey = new Map(claims.map(claim => [claim.client_claim_key, claim]));
  const proposed: Link[] = [...links, ...claims.flatMap(claim => claim.relations
    .filter(relation => relation.type !== 'informed_by')
    .map(relation => ({final_claim_key: claim.client_claim_key, target_draft_claim_id: relation.target_claim_id, target_draft_claim_version_id: relation.target_claim_version_id, reason: relation.reason})))];
  const targets = [...context.draft_context.claims,
    ...context.verified_context.active_claims, ...context.verified_context.recent_history,
    ...context.verified_context.open_questions, ...context.verified_context.active_risks];
  for (const link of proposed) {
    const source = byKey.get(link.final_claim_key);
    const target = targets.find(claim => claim.claimId === link.target_draft_claim_id && claim.claimVersionId === link.target_draft_claim_version_id);
    if (!source || !target) continue;
    const disproved = link.alignment && Object.values(link.alignment).some(value => !value);
    const contradictsReason = /\bdoes not (?:answer|resolve|establish|support|confirm)\b|\b(?:populations|dimensions|metrics|subjects) (?:and (?:populations|dimensions|metrics|subjects) )?differ\b|\bdifferent (?:institutions|organizations|populations|measurement units|fee types)\b/i.test(link.reason ?? '');
    // Missing historical metadata is not proof of incompatibility. The new
    // verifier must still compare the original statements and their sources.
    const sourceInstitution = institutionFromTitle(context.new_event.title);
    const targetInstitution = institutionFromTitle(target.eventTitle);
    // Titles alone do not define the proposition. An explicit institution-owned
    // observation plus different source institutions establishes incompatible
    // attribution. General industry views and shared project decisions remain comparable.
    const attributionMismatch = sourceInstitution && targetInstitution && sourceInstitution !== targetInstitution &&
      (ownsObservation(source.statement, sourceInstitution) || ownsObservation(target.statement, targetInstitution)) &&
      !(ownsObservation(source.statement, targetInstitution) || ownsObservation(target.statement, sourceInstitution));
    if (disproved || contradictsReason || attributionMismatch || ['comparison_subject', 'comparison_dimension', 'comparison_scope'].some(name => {
      const left = field(source.normalized_value, name);
      const right = field(target.normalizedValue, name);
      return left && right && left !== right;
    })) issues.push({claimKey: source.client_claim_key, targetVersionId: target.claimVersionId, reason: 'comparison_scope_mismatch'});
  }
  return issues;
}

export function retainUncertainMetrics(claims: Claim[]): Claim[] {
  return claims.map(claim => hasRateDurationMismatch(claim) ? {
    ...claim,
    type: 'open_question',
    statement: 'The reported rate increase is unclear. The quoted number is a duration.',
    normalized_value: null,
    needs_additional_evidence: true,
    uncertainty: {
      reason: 'A duration cannot establish a rate. Check the neighboring source statements.',
      alternatives: ['The number describes additional processing time.', 'The source needs a corrected rate or denominator.'],
      question: 'What was the reported rate increase, and what unit or denominator was used?',
    },
    relations: [],
  } : claim);
}
