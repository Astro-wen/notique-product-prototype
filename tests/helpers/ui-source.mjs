import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Reads every UI source file once and indexes its top-level declarations by
 * name through the TypeScript AST. Tests locate code by name instead of by
 * byte offset in a single file, so reordering declarations, reformatting, or
 * moving a component into its own file does not rewrite the test contract.
 */
async function collectSources(dir) {
  const files = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectSources(relative));
    else if (/\.tsx?$/.test(entry.name)) files.push(relative);
  }
  return files;
}

const uiFiles = (await collectSources("app")).sort();
const sources = new Map(await Promise.all(
  uiFiles.map(async (file) => [file, await readFile(path.join(root, file), "utf8")]),
));

/** Every UI source concatenated, for assertions that do not care where code lives. */
export const uiSource = uiFiles.map((file) => sources.get(file)).join("\n");

export function uiSourceFiles() {
  return [...uiFiles];
}

function declaredNames(node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name ? [node.name.text] : [];
  }
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    return [node.name.text];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name))
      .map((declaration) => declaration.name.text);
  }
  return [];
}

const asts = new Map();
function astFor(file) {
  if (!asts.has(file)) {
    asts.set(file, ts.createSourceFile(file, sources.get(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  }
  return asts.get(file);
}

const index = new Map();
for (const file of uiFiles) {
  const text = sources.get(file);
  const ast = astFor(file);
  const record = (name, node) => {
    const entry = { file, body: text.slice(node.getStart(ast), node.getEnd()) };
    if (index.has(name)) index.get(name).push(entry);
    else index.set(name, [entry]);
  };
  // Nested declarations are indexed too: much of the workspace still lives
  // inside one large component, and tests need to reach those bodies without
  // slicing the file by byte offset.
  const visit = (node) => {
    for (const name of declaredNames(node)) record(name, node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(ast, visit);
}

function resolve(name) {
  const entries = index.get(name);
  if (!entries?.length) throw new Error(`declaration "${name}" was not found under app/`);
  if (entries.length > 1) {
    throw new Error(`declaration "${name}" is ambiguous: ${entries.map((entry) => entry.file).join(", ")}`);
  }
  return entries[0];
}

/**
 * Source of the named top-level declaration, wherever it lives under app/.
 * Throws when the name is missing or ambiguous, so a rename fails loudly
 * instead of silently asserting against an empty slice.
 */
export function declarationSource(name) {
  return resolve(name).body;
}

/** File that declares `name`, for assertions about where code lives. */
export function declarationFile(name) {
  return resolve(name).file;
}

/**
 * Smallest complete statement that contains `needle`, for assertions about a
 * block that has no name of its own — a useEffect, for example. Anchoring on a
 * distinctive fragment of the block survives reordering and reformatting in a
 * way that slicing between two neighbouring declarations does not.
 */
export function statementContaining(needle) {
  const found = [];
  for (const file of uiFiles) {
    const text = sources.get(file);
    let from = text.indexOf(needle);
    while (from >= 0) {
      const ast = astFor(file);
      let smallest = null;
      const visit = (node) => {
        if (node.getStart(ast) > from || node.getEnd() < from + needle.length) return;
        if (ts.isStatement(node)) smallest = node;
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(ast, visit);
      if (smallest) found.push({ file, body: text.slice(smallest.getStart(ast), smallest.getEnd()) });
      from = text.indexOf(needle, from + needle.length);
    }
  }
  if (found.length === 0) throw new Error(`no statement under app/ contains ${JSON.stringify(needle)}`);
  if (found.length > 1) {
    throw new Error(`${JSON.stringify(needle)} is ambiguous: ${found.length} statements in ${[...new Set(found.map((item) => item.file))].join(", ")}`);
  }
  return found[0].body;
}

/**
 * The `useEffect` call that encloses `needle`, or the first one that follows it
 * when the anchor sits just above the effect. Naming the effect by a fragment
 * of its own body is stable across reordering; slicing to whatever declaration
 * happens to come next is not.
 */
export function effectContaining(needle) {
  const found = [];
  for (const file of uiFiles) {
    const text = sources.get(file);
    const ast = astFor(file);
    let from = text.indexOf(needle);
    while (from >= 0) {
      const to = from + needle.length;
      let enclosing = null;
      let following = null;
      const visit = (node) => {
        if (!isUseEffectCall(node)) return ts.forEachChild(node, visit);
        const start = node.getStart(ast);
        if (start <= from && node.getEnd() >= to) enclosing = node;
        else if (start >= to && (!following || start < following.getStart(ast))) following = node;
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(ast, visit);
      const match = enclosing || following;
      if (match) found.push({ file, body: text.slice(match.getStart(ast), match.getEnd()) });
      from = text.indexOf(needle, to);
    }
  }
  if (found.length === 0) throw new Error(`no useEffect under app/ is anchored by ${JSON.stringify(needle)}`);
  if (found.length > 1) {
    throw new Error(`${JSON.stringify(needle)} is ambiguous: ${found.length} effects in ${[...new Set(found.map((item) => item.file))].join(", ")}`);
  }
  return found[0].body;
}

function isUseEffectCall(node) {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "useEffect";
}

/** Every declared top-level name, for coverage-style assertions. */
export function declaredSymbols() {
  return [...index.keys()].sort();
}
