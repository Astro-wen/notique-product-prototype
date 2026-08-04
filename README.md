# Notique Classification Agent Mock

A complete, clickable product mock for testing AI-assisted filing in Notique.

## Core flow

1. Open **Inbox** or click **Import**.
2. Drop in a local file or choose one of the three sample items.
3. Notique analyzes the item and proposes two likely Projects.
4. The user selects one suggestion and clicks **Allow and file**.
5. The item appears inside the selected Project with a **Filed by AI** label.

Nothing is filed without explicit user approval.

## Other interactions

- Create and rename Projects.
- Open a Project and browse a simple content list.
- Open recordings and individual items.
- Rename an item.
- Move an item to Trash and restore it.
- Keep an AI-classified item in Inbox instead of filing it.
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
