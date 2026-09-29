/** A manual action written after Summary is absent from the frozen model input.
 * Pair only unambiguous, source-identical actions when the model later publishes. */
export type EarlyActionEvidence = {
  assetVersionId: string;
  segmentIdsJson: string | null;
};

export type EarlyManualAction = {
  claimId: string;
  versionId: string;
  statement: string;
  evidence: readonly EarlyActionEvidence[];
};

export type PublishedAction = {
  claimId: string;
  versionId: string;
  clientClaimKey: string;
  statement: string;
  confidence: number;
  evidence: readonly EarlyActionEvidence[];
};

export type ActionOverlap = {
  manual: EarlyManualAction;
  model: PublishedAction;
  confidence: number;
};

function sourceSignature(evidence: readonly EarlyActionEvidence[]): string | null {
  const locations = new Set<string>();
  for (const ref of evidence) {
    if (!ref.assetVersionId || !ref.segmentIdsJson) continue;
    let segmentIds: unknown;
    try { segmentIds = JSON.parse(ref.segmentIdsJson); } catch { continue; }
    if (!Array.isArray(segmentIds)) continue;
    for (const segmentId of segmentIds) {
      if (typeof segmentId === 'string' && segmentId) locations.add(`${ref.assetVersionId}:${segmentId}`);
    }
  }
  return locations.size ? [...locations].sort().join('|') : null;
}

function actionMeaning(statement: string): { text: string; synonym: boolean } {
  // Currency, decimal separators, comparisons and ranges are part of the
  // proposition. Preserve them and word boundaries instead of erasing all
  // punctuation, which can turn different amounts into an identical action.
  const compact = statement.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
    .replace(/[。!?]$/u, '');
  // These two verbs are equivalent only when the entire remaining proposition
  // is identical. No fuzzy distance, substring, or shared-source-only match.
  const text = compact.replace(/核实|查证/g, '确认');
  return { text, synonym: text !== compact };
}

export function selectEarlyActionOverlaps(
  manual: readonly EarlyManualAction[],
  model: readonly PublishedAction[],
): ActionOverlap[] {
  const possibilities: ActionOverlap[] = [];
  for (const human of manual) {
    const humanSource = sourceSignature(human.evidence);
    if (!humanSource) continue;
    const humanMeaning = actionMeaning(human.statement);
    if (humanMeaning.text.length < 8) continue;
    for (const suggestion of model) {
      if (!Number.isFinite(suggestion.confidence) || suggestion.confidence < 0.85 || suggestion.confidence > 1) continue;
      if (sourceSignature(suggestion.evidence) !== humanSource) continue;
      const modelMeaning = actionMeaning(suggestion.statement);
      if (humanMeaning.text !== modelMeaning.text) continue;
      possibilities.push({ manual: human, model: suggestion,
        confidence: Math.min(suggestion.confidence, humanMeaning.synonym || modelMeaning.synonym ? 0.9 : 1) });
    }
  }
  const manualCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  for (const pair of possibilities) {
    manualCounts.set(pair.manual.claimId, (manualCounts.get(pair.manual.claimId) ?? 0) + 1);
    modelCounts.set(pair.model.claimId, (modelCounts.get(pair.model.claimId) ?? 0) + 1);
  }
  return possibilities.filter(pair => manualCounts.get(pair.manual.claimId) === 1 && modelCounts.get(pair.model.claimId) === 1);
}
