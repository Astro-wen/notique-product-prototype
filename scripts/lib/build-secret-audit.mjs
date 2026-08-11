import { readdir, readFile, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const FORBIDDEN_BASENAME_PATTERNS = [
  /^\.dev\.vars(?:\..+)?$/i,
  /^\.env(?:\..+)?$/i,
  /^\.?secrets?(?:\..+)?$/i,
  /^(?:credentials?|service-account)(?:\..+)?$/i,
  /^\.(?:npmrc|netrc|yarnrc(?:\.yml)?)$/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
];

const SECRET_CONTENT_PATTERNS = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", pattern: /gh[opusr]_[A-Za-z0-9]{20,}/ },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  { name: "generic-sk-key", pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  {
    name: "literal-api-key-assignment",
    pattern:
      /\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*["'][^"'\r\n]{12,}["']/,
  },
  { name: "basic-auth-url", pattern: /https?:\/\/[^\s/:@]+:[^\s/@]{8,}@/i },
];

function normalizeRelativePath(root, filePath) {
  return relative(root, filePath).split(sep).join("/");
}

export function isForbiddenPackagePath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.some((part) =>
    FORBIDDEN_BASENAME_PATTERNS.some((pattern) => pattern.test(part)),
  );
}

async function collectPackageEntries(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = [];

  for (const entry of entries) {
    const filePath = resolve(directory, entry.name);
    const relativePath = normalizeRelativePath(root, filePath);

    if (entry.isSymbolicLink()) {
      collected.push({ filePath, relativePath, kind: "symbolic-link" });
    } else if (entry.isDirectory()) {
      collected.push({ filePath, relativePath, kind: "directory" });
      collected.push(...(await collectPackageEntries(root, filePath)));
    } else if (entry.isFile()) {
      collected.push({ filePath, relativePath, kind: "file" });
    }
  }

  return collected;
}

export async function findForbiddenPackagePaths(packageDirectory) {
  const root = resolve(packageDirectory);
  const entries = await collectPackageEntries(root);
  const candidates = entries
    .filter(({ relativePath }) => isForbiddenPackagePath(relativePath))
    .map(({ relativePath }) => relativePath)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));

  return candidates
    .filter(
      (candidate) =>
        !candidates.some(
          (possibleParent) =>
            possibleParent !== candidate && candidate.startsWith(`${possibleParent}/`),
        ),
    )
    .sort();
}

async function findSecretContentFindings(packageDirectory) {
  const root = resolve(packageDirectory);
  const files = await collectPackageEntries(root);
  const findings = [];

  for (const file of files) {
    if (file.kind === "symbolic-link") {
      findings.push({ path: file.relativePath, rule: "symbolic-link" });
      continue;
    }
    if (file.kind !== "file") continue;
    if (isForbiddenPackagePath(file.relativePath)) continue;

    const content = await readFile(file.filePath);
    const text = content.toString("utf8");

    for (const rule of SECRET_CONTENT_PATTERNS) {
      if (rule.pattern.test(text)) {
        findings.push({ path: file.relativePath, rule: rule.name });
      }
    }
  }

  return findings.sort((left, right) =>
    `${left.path}:${left.rule}`.localeCompare(`${right.path}:${right.rule}`),
  );
}

export async function cleanForbiddenPackagePaths(packageDirectory) {
  const root = resolve(packageDirectory);
  const forbiddenPaths = await findForbiddenPackagePaths(root);

  for (const relativePath of forbiddenPaths) {
    await rm(resolve(root, relativePath), { force: true, recursive: true });
  }

  return forbiddenPaths;
}

export async function auditBuildPackage(packageDirectory) {
  const forbiddenPaths = await findForbiddenPackagePaths(packageDirectory);
  const contentFindings = await findSecretContentFindings(packageDirectory);
  return { forbiddenPaths, contentFindings };
}
