import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const FORBIDDEN_OUTPUT_BASENAMES = [
  /^\.dev\.vars(?:\..+)?$/i,
  /^\.env(?:\..+)?$/i,
  /^\.?secrets?(?:\..+)?$/i,
  /^(?:credentials?|service-account)(?:\..+)?$/i,
  /^\.(?:npmrc|netrc|yarnrc(?:\.yml)?)$/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
];

function isForbiddenOutput(fileName: string): boolean {
  return fileName
    .split("/")
    .some((part) => FORBIDDEN_OUTPUT_BASENAMES.some((pattern) => pattern.test(part)));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}

// The Cloudflare Vite plugin emits local preview variables into the server
// bundle. They are useful for `vite preview`, but a Sites package must never
// contain local environment files or private keys.
export function stripLocalSecrets(): Plugin {
  return {
    name: "strip-local-secrets",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (isForbiddenOutput(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}
