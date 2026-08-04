# Notique Product Prototype

A complete, clickable product mock for testing the full Notique workflow with realistic local data. AI processing, transcription, evidence linking and sending are simulated so the product can be tested without production services.

## Core flow

1. Open **Inbox** or click **Import**.
2. Drop in a local file or choose one of the three sample items.
3. Notique shows a realistic processing sequence, analyzes the item and proposes two likely Projects.
4. The user selects one suggestion and clicks **Allow and file**.
5. The item appears inside the selected Project with a **Filed by AI** label.

Nothing is filed without explicit user approval.

## Other interactions

- Continue from a realistic home dashboard with review, Inbox and activity counts.
- Record a new meeting, call or site visit and simulate transcription, timeline creation and project analysis.
- Create and rename Projects.
- Open a Project as a simple folder and browse its content list.
- Enter the AI workspace without making the folder itself complicated.
- Review the latest Event Result and its Context Page.
- Work through a risk-based Review Queue.
- Open a Claim, inspect supporting and conflicting evidence, ask AI, confirm, edit, reject or keep it pending.
- Compare the same project facts across several events.
- See the reviewed Current Understanding of a Project.
- Generate Project Briefs, Change Orders, Decision Logs and Smart Checklists.
- Complete checklist items and attach evidence to individual fields.
- Save, export and send generated documents to a mock recipient.
- Invite collaborators, set access and copy a project share link.
- Open recordings and individual items.
- Rename an item.
- Move an item between Projects.
- Move an item to Trash and restore it.
- Keep an AI-classified item in Inbox instead of filing it.
- Search Projects and browse reusable deliverable templates.
- Open notifications, profile and workspace settings.
- Keep all demo changes after refresh with browser-local persistence, and reset the demo from settings.
- Use desktop or responsive mobile navigation.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Then open the local address printed in the terminal.

## Verify a build

```bash
npm test
```

## Main files

- `app/page.tsx`: product data, navigation and complete mock interactions.
- `app/globals.css`: desktop and mobile styling.
- `app/layout.tsx`: page metadata.

This mock uses local React state. It does not upload files or call a production AI service.
