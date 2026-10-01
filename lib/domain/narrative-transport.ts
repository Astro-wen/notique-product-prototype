import type { WorkflowNarrativeInput } from './workflow-narrative.ts';

/** Short, request-local references reduce formatting overhead. Only exact
 * frozen IDs are persisted, and the normal validator still checks each pair. */
export function narrativeTransport(input: WorkflowNarrativeInput, feedback: readonly string[]) {
  const claims = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const b of input.bullets) for (const r of b.claimRefs) {
    if (!claims.has(r.claimId)) claims.set(r.claimId, `c${claims.size}`);
    if (!versions.has(r.claimVersionId)) versions.set(r.claimVersionId, `v${versions.size}`);
  }
  const originalClaims = new Map([...claims].map(([id, alias]) => [alias, id]));
  const originalVersions = new Map([...versions].map(([id, alias]) => [alias, id]));
  const encodeRef = (r: {claimId: string; claimVersionId: string}) => ({claimId: claims.get(r.claimId)!, claimVersionId: versions.get(r.claimVersionId)!});
  return {
    input: {...input, bullets: input.bullets.map(b => ({...b, claimRefs: b.claimRefs.map(encodeRef)}))},
    feedback: feedback.map(line => {
      for (const [id, alias] of [...claims, ...versions]) line = line.replaceAll(JSON.stringify(id), JSON.stringify(alias));
      return line;
    }),
    decode(value: unknown): unknown {
      if (!value || typeof value !== 'object' || !('sentences' in value) || !Array.isArray(value.sentences)) return value;
      return {...value, sentences: value.sentences.map(s => {
        if (!s || typeof s !== 'object' || !Array.isArray(s.claim_refs)) return s;
        return {...s, claim_refs: s.claim_refs.map((r: unknown) => {
          if (!r || typeof r !== 'object') return r;
          const ref = r as Record<string, unknown>;
          return {...ref, claimId: typeof ref.claimId==='string' ? originalClaims.get(ref.claimId) ?? ref.claimId : ref.claimId, claimVersionId: typeof ref.claimVersionId==='string' ? originalVersions.get(ref.claimVersionId) ?? ref.claimVersionId : ref.claimVersionId};
        })};
      })};
    },
  };
}
