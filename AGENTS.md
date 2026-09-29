# Notique shared development workflow

Updated 2026-09-28. This file is the current workflow for every agent, including Codex and Claude. Older handoff documents and release notes are historical where they disagree with it.

## One checkout, one branch

- Canonical checkout: `/Users/aaronwen/.codex/.chatgpt-projects/g-p-6a5d6f7835f481919605aafa8c6b3c50/notique-web-demo`.
- `/Users/aaronwen/Notique-AI` and `/Users/aaronwen/Desktop/简历修改/projects/notique-product-prototype` are aliases of this same checkout, not independent copies. Use the resolved canonical path for tools.
- `main` is the only long-lived development and release branch. Its upstream is `origin/main` in `Astro-wen/notique-product-prototype`.
- Do not recreate `publish-main`, `ux/live-copy`, or an independent development copy. Create a temporary branch/worktree only when the user explicitly asks for isolation; merge and remove it when finished.
- Before editing, check `pwd -P`, `git status --short --branch`, and fetch `origin`. On a clean `main`, update with `git pull --ff-only origin main`. If the branch, local changes, or history differ, inspect and preserve them before reconciling; do not reset, force-push, or discard another agent's work.
- Sharing a branch does not make concurrent edits safe. Only one agent may edit a given file at a time. Coordinate ownership before writing; other agents may inspect without modifying. Recheck the diff before committing.
- Preserve the simplified product flow established in `36b2f47` and merged as `e915124`: evidence details show source text/audio; decisions happen in pending review; actions come from model suggestions; manual claim/action entry forms stay removed unless the user explicitly changes direction.

## Run and verify

- Use the existing shared development server at `http://localhost:3000`. Check the listener before starting another server. Start with `npm run dev -- --port 3000` when needed.
- Local `.dev.vars` / `.env*` files and `.wrangler` state are private runtime data. Do not commit them, overwrite databases, or copy secrets into logs.
- Run focused tests during development. Before a production release, run `npm run typecheck`, `npm run lint`, and `npm test` (includes the production build and package secret audit).
- Passing engineering tests does not establish model precision/recall or real-device acceptance.

## GitHub and Sites

- Push approved work to `origin/main`; normal pushes only. Do not maintain a separate release branch.
- GitHub Pages is only the static entry page. Pushing `main` triggers that workflow; it does not publish the full Sites application.
- Publish the same committed `main` source to the existing Sites project in `.openai/hosting.json`, using the Sites hosting workflow. Reuse its project ID, D1/R2 bindings, and audience. Confirm the saved version's source SHA equals GitHub `main` and the deployment succeeds.
- Keep production runtime secrets and environment values unless the user requests a change. Runtime values may intentionally differ from local defaults; inspect them separately from Git source. The current production settings include high/high fact reasoning and a 100 MiB audio limit.
- Backups of retired branches and the former desktop checkout are outside the repo at `../notique-backups/2026-09-28-unify-main/`. These are recovery archives, not active workspaces.

## Workflow V2 implementation specifications

- Product scope updated by the user on 2026-09-29: PC only. Prioritize desktop/laptop layouts, mouse and keyboard interaction. Browser QA uses desktop and laptop viewports. Existing mobile compatibility may remain, but mobile-specific development and acceptance are outside the current scope.

- For Workflow V2 work, read `docs/FRONTEND_TECHNICAL_PLAN.md` and `docs/BACKEND_TECHNICAL_PLAN.md` together. These are implementation specifications, not a claim that V2 is already shipped.
- Keep both documents and `docs/WORKFLOW_V2_CONTRACT.json` consistent when changing workflow states or interfaces. The contract manifest describes the planned API. Implement compiled shared types and runtime validation in `lib/shared/workflow-v2.ts`.
- Preserve the three valid exits: reading only, partial acceptance, and follow-up with results. An action being completed and a question being answered are separate states. Questions can be answered directly.
- Reuse the existing claim/version/verdict/relation ledger. Derived summaries reference exact versions, and every write entry point invalidates affected outputs.
- Implement in the staged order and verify the product paths defined in both specifications. Record engineering tests, actual UI walkthroughs, and model-quality evaluation separately.
