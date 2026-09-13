# Notique — AI Project Memory

**Turn conversations into project memory you can trace, review, and use.**

Notique is an AI product prototype for people who manage ongoing client conversations. It brings transcripts, recordings, and photos into one project, extracts proposed facts, and connects each proposal to its original evidence. Users review the AI draft before it becomes lasting project memory, a change timeline, or a briefing for the next conversation.

[Open the application](https://notique-evidence-workspace.uclae2e12.chatgpt.site/) · [Static interface preview](https://astro-wen.github.io/notique-product-prototype/) · [Product case study](docs/PRODUCT_OVERVIEW.md) · [中文工程说明](README.zh-CN.md)

## The problem

A meeting summary captures one conversation. Ongoing work requires knowing what is still true after the next conversation: a client's revised preference, a changed decision, an unresolved question, or a new risk. Manually reconciling these changes is slow, while an AI summary without accessible evidence is difficult to trust.

Notique uses AI to prepare a draft, lets people inspect the source and resolve uncertainty, then builds the next conversation on confirmed information.

## Product walkthrough

```text
Add material → AI draft → Review against sources → Confirmed project memory
                                                       ↓
Next conversation ← Meeting brief ← Decisions, preferences, and changes
```

1. **Add a conversation.** Create a project, import a transcript, upload supported audio or photos, or record in the browser.
2. **Generate an AI draft.** Audio is transcribed with speakers and timestamps. A two-stage pipeline extracts proposed facts and checks omissions, changes, and relationships.
3. **Inspect the evidence.** Open a highlighted statement to see its original passage and surrounding context; where audio is available, play the relevant moment.
4. **Make the decision.** Confirm, edit, reject, or add missing information. Review proposed relationships such as a new decision superseding an old one.
5. **Prepare for what comes next.** Read confirmed decisions, preferences, questions, risks, and a timeline of changes. Later conversations inherit confirmed memory.

The full application contains the server-backed workflow; access depends on its configured identity gateway. GitHub Pages is a static interface preview and does not run the extraction backend.

## What is implemented

| Capability | Implementation |
| --- | --- |
| Conversation capture | Transcript import, browser recording, audio transcription, and supported photo uploads |
| AI draft | Two-stage extraction and verification with conditional additional review |
| Source inspection | Transcript quotations, speaker and timestamp references, contextual highlighting, and audio playback |
| Human review | Confirm, edit, reject, and supplement facts; separately accept or reject changes between facts |
| Project memory | Confirmed records feed summaries, timelines, preferences, risks, and meeting briefs |
| Reliable execution | Persisted model response IDs, resumable jobs, idempotent mutations, retries, and stage-level timing |
| Evaluation | Offline scoring for recall, precision, evidence support, relationships, stability, and brief quality |

## Product decisions

- **Review before memory.** Pending and rejected proposals cannot enter formal reports or become context for later conversations.
- **Evidence beside the decision.** Reviewing a claim includes seeing what was actually said, not just a model confidence score.
- **Separate draft quality from corrected quality.** Human fixes can improve the final record while hiding weaknesses in the original AI output; evaluation tracks these separately.
- **Resume existing work.** Refreshing a page or checking status reconnects to an existing run rather than starting another paid model request.
- **Build reports from confirmed records.** Formal views use deterministic rules rather than another unconstrained generation step.

See the [product case study](docs/PRODUCT_OVERVIEW.md) for scope, trade-offs, and next validation steps.

## Architecture

```text
React / TypeScript interface
          │
Server API: workspace access, validation, idempotency
          ├── Cloudflare D1: projects, jobs, facts, evidence, review decisions
          ├── Cloudflare R2: versioned source materials and audio
          └── Persisted background jobs
                    ├── Audio transcription
                    └── Extraction → Verification → Evidence checks → Human review
                                                                        │
                                                   Confirmed records → Project views
```

The frontend uses React, TypeScript, and a Vinext/Vite runtime. Server data uses Drizzle with Cloudflare D1; original assets use R2. The OpenAI provider uses the Responses API with persisted background response IDs. A DeepSeek adapter supports text-only input. Provider credentials stay on the server.

## Run locally

Requires **Node.js 22.13 or later** and npm.

```bash
git clone https://github.com/Astro-wen/notique-product-prototype.git
cd notique-product-prototype
npm ci
cp .env.example .env.local
npm run db:migrate:local
npm run dev
```

Open `http://localhost:3000`. The development configuration provides local D1/R2 bindings. Keep `APP_ENV=local` for local development.

To run real extraction, fill in the server-side `.env.local` values:

```dotenv
APP_ENV=local
AI_PROVIDER=openai
AI_MODEL=<a model supporting the configured Responses API workflow>
AI_API_KEY=<your server-side API key>
INTERNAL_JOB_TOKEN=<a strong random secret>
AI_TWO_PASS_PIPELINE=1
AI_REASONING_EFFORT=xhigh
AI_VERIFIER_REASONING_EFFORT=high
```

Use a model supporting the configured reasoning levels and image input when needed. Audio transcription has a separate `AI_TRANSCRIPTION_MODEL` setting. See [the engineering reference](README.zh-CN.md#模型和任务配置) and [`.env.example`](.env.example) for additional settings.

You can inspect the interface without a model key. Extraction returns `MODEL_PROVIDER_NOT_CONFIGURED` until configured; it does not insert fabricated AI results. Starting real transcription or extraction can incur provider charges.

For the static interface only, run `npm run build:pages`. This produces `pages-dist/` for GitHub Pages, without the backend or AI extraction service.

## Checks and evaluation

```bash
npm run typecheck
npm run lint
npm run test:domain
npm run test:audit
npm test
```

`npm test` builds the application and runs automated checks. These checks do not establish model quality or customer validation.

Offline evaluation takes reviewed ground truth and predictions:

```bash
npm run eval -- path/to/ground-truth.json path/to/predictions.json path/to/report.json
```

The repository includes synthetic contractor, real-estate, and insurance scenarios for repeatable development. They are development fixtures, not customer studies. The [evaluation guide](eval/README.md) explains matching, evidence checks, sample eligibility, and independent-run requirements.

## Current status and limits

This is an actively developed product prototype. The recorded Sites v17 release passed desktop read-only navigation and evidence-view checks using existing records. The new background architecture still needs a fresh paid end-to-end run on that release, and real-device mobile review remains pending.

A documented public-meeting evaluation surfaced recall and semantic evidence-support gaps. Formal concept-validation gates have not passed. These findings inform the next iteration; they are not production accuracy or customer-impact claims.

- PDF upload does not yet imply PDF understanding: a text/page extraction adapter is still needed.
- Supported photos are JPEG, PNG, and WebP; HEIC/HEIF conversion is not implemented.
- Production use requires a correctly configured identity gateway, private storage, server secrets, and workspace isolation.

Detailed release evidence and outstanding work are in [the progress report](docs/ERIC_MVP_PROGRESS.md) and [acceptance checklist](tests/ACCEPTANCE_CHECKLIST.md).

## Repository guide

| Path | Purpose |
| --- | --- |
| `app/` | Application pages and API routes |
| `lib/domain/` | Extraction contracts, evidence rules, review states, and project views |
| `lib/server/` | Model adapters, repositories, storage, and background jobs |
| `db/`, `drizzle/` | Database schema and migrations |
| `eval/` | Evaluation definitions and development fixtures |
| `tests/` | Automated tests and acceptance criteria |
| `github-pages/` | Static interface preview |

For a walkthrough, see the [user manual](docs/USER_MANUAL.md). For implementation and deployment details, see the [engineering reference](README.zh-CN.md) and [maintainer handoff](docs/CLAUDE_HANDOFF.md).
