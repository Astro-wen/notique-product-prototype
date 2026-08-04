import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const cssUrl = new URL("../app/globals.css", import.meta.url);
const readProduct = () => Promise.all([readFile(pageUrl, "utf8"), readFile(cssUrl, "utf8")]);

test("keeps the complete input to delivery flow in the product", async () => {
  const [page] = await readProduct();
  for (const marker of [
    "Preparing this item",
    "Suggested projects",
    "Project record",
    "Review this update",
    "Compare events",
    "Attach evidence",
    "Send this document",
    "Record a new event",
  ]) assert.match(page, new RegExp(marker));
});

test("preserves realistic product state and recovery actions", async () => {
  const [page] = await readProduct();
  assert.match(page, /localStorage\.setItem\("notique-demo-state-v2"/);
  assert.match(page, /Move item/);
  assert.match(page, /Item restored/);
  assert.match(page, /Reset demo data/);
  assert.match(page, /Project invitation sent/);
});

test("includes responsive layouts for the added product surfaces", async () => {
  const [, css] = await readProduct();
  assert.match(css, /\.processing-steps/);
  assert.match(css, /\.home-summary/);
  assert.match(css, /\.event-capture-modal/);
  assert.match(css, /@media \(max-width: 560px\)/);
});
