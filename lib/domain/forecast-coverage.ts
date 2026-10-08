import type {ContextPack} from './context-pack';
import type {InventoryOutput} from './two-stage-extraction';

export const LEGACY_FORECAST_COVERAGE_POLICY = 'explicit-source-financial-forecasts.v1' as const;
export const FORECAST_COVERAGE_POLICY = 'explicit-source-financial-forecasts.v2' as const;
const financialTerms = /\b(?:fees?|prices?|costs?|margins?|profits?)\b|费用|价格|成本|利润/i;

/** Source selection only. The existing verifier must interpret these excerpts. */
export function retainFinancialForecastSources(inventory: InventoryOutput, context: ContextPack, policy: string = FORECAST_COVERAGE_POLICY): {inventory: InventoryOutput; addedKeys: string[]} {
  const covered = new Set(inventory.candidates.filter(candidate => policy === LEGACY_FORECAST_COVERAGE_POLICY || financialTerms.test(candidate.statement)).flatMap(candidate => candidate.evidence.flatMap(evidence => 'segment_ids' in evidence && evidence.evidence_role === 'direct' ? evidence.segment_ids : [])));
  const segments = context.new_event.transcript_segments;
  const additions: InventoryOutput['candidates'] = [];
  for (let index = 0; index < segments.length && additions.length < 8; index++) {
    const segment = segments[index];
    const text = segment.textRaw;
    if (covered.has(segment.id) || !financialTerms.test(text)) continue;
    if (!/\b(?:will|would|could|should|may|expect\w*|guess|hypothes\w*|predict\w*|forecast\w*)\b|\bgoing to\b|预计|预期|可能|认为/i.test(text)) continue;
    if (inventory.candidates.length + additions.length >= 64) break;
    let inventoryKey = `source_forecast_${index + 1}`;
    if (policy !== LEGACY_FORECAST_COVERAGE_POLICY) {
      while (inventory.candidates.some(candidate => candidate.inventory_key === inventoryKey)) inventoryKey += '_financial';
    }
    const preceding = segments.slice(Math.max(0, index - 2), index).filter(item => item.assetVersionId === segment.assetVersionId && item.speaker === segment.speaker);
    additions.push({
      inventory_key: inventoryKey,
      type: 'property_fact',
      statement: `${segment.speaker ? `${segment.speaker}: ` : ''}${text}`,
      normalized_value: {source_forecast_candidate: true},
      materiality: 'high', critical: true,
      critical_reason: 'An explicit financial expectation needs verification with its attribution, conditions and horizon before comparing conversations.',
      confidence: 0.9, atomicity: 'atomic',
      evidence: [
        {kind: 'transcript', asset_version_id: segment.assetVersionId, segment_ids: [segment.id], quote_hint: text, evidence_role: 'direct'},
        ...preceding.map(item => ({kind: 'transcript' as const, asset_version_id: item.assetVersionId, segment_ids: [item.id], quote_hint: item.textRaw, evidence_role: 'contextual' as const})),
      ],
    });
  }
  return {inventory: {...inventory, candidates: [...inventory.candidates, ...additions]}, addedKeys: additions.map(item => item.inventory_key)};
}
