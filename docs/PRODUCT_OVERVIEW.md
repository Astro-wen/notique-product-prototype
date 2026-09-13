# Notique: From conversations to reliable project memory

## Project introduction

Notique is an AI application prototype that turns ongoing client conversations into reviewable project memory. Users import transcripts, recordings, and photos; inspect an AI draft against its original evidence; and confirm the information that should carry forward. Confirmed records power decisions, preferences, change timelines, and meeting briefs. The project combines a product workflow with server APIs, persistent storage, background model execution, and an offline evaluation framework.

## User problem and scope

For people managing ongoing client work, the difficult part of note-taking is often reconciling one conversation with the next. Preferences evolve, decisions get replaced, and an unresolved question can quietly disappear inside a new summary.

The prototype focuses on that continuity problem. Contractor, real-estate, and insurance scenarios provide development fixtures for exploring it. Those fixtures are synthetic; they are not evidence of validated demand in all three markets.

The core product question is: **Can AI reduce the effort of maintaining useful project memory while keeping each retained fact inspectable and under the user's control?**

## The core experience

1. Add material to a project conversation.
2. Read the AI draft, with source references attached to its key points.
3. Inspect the original quote, context, speaker, and audio timestamp where available.
4. Confirm, edit, reject, or add information, and resolve proposed changes between records.
5. Read a project brief or change timeline before the next conversation.

Subsequent analysis uses previously confirmed memory. Unreviewed AI proposals do not silently become project facts.

## Decisions and trade-offs

| Decision | Benefit | Trade-off |
| --- | --- | --- |
| Human confirmation before lasting memory | Users control what becomes a formal record | Review effort becomes a key usability constraint |
| Original evidence beside each proposal | Users can inspect the basis of a conclusion | Exact quotations alone do not prove semantic support |
| Two-stage extraction and verification | Separates initial coverage from checking omissions and changes | Adds latency, cost, and orchestration complexity |
| Deterministic reports from confirmed records | Prevents new unsupported assertions during reporting | Less flexible than unconstrained prose generation |
| Persisted jobs and model response IDs | Refreshes and retries can resume existing work | Requires explicit states, recovery paths, and timing visibility |

## What the implementation demonstrates

- A complete workflow from material import through review to reusable project views.
- API and data design connecting conversations, source assets, model runs, proposed facts, evidence, and review decisions.
- Background execution with persisted provider response IDs and retry-safe operations.
- Product iteration around evidence readability, predictable navigation, refresh recovery, sequential review, and visible waiting time.
- Evaluation that distinguishes raw AI output from the final result after human correction.

## Evidence and next iteration

The repository records a deployed prototype and desktop read-only validation of the Sites v17 release. It also records a public-meeting evaluation that exposed missed facts and weak semantic support in some citations. Those findings are useful development evidence, but formal concept validation remains incomplete.

The next priorities are to validate the new background pipeline with a fresh deployed run, improve fact coverage and citation support, measure review effort on complete user journeys, and complete mobile browser validation. Synthetic fixtures support regression checks; broader quality claims require independently reviewed data and repeated runs.

See the [progress report](ERIC_MVP_PROGRESS.md), [evaluation guide](../eval/README.md), and [acceptance checklist](../tests/ACCEPTANCE_CHECKLIST.md) for the underlying evidence.
