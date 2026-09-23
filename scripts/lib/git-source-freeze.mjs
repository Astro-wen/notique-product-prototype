function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeState(state) {
  return {
    headBefore: String(state?.headBefore ?? "").trim(),
    headAfter: String(state?.headAfter ?? "").trim(),
    status: String(state?.status ?? "").trim(),
  };
}

export function validateCleanGitSourceState(state, {
  checkpoint,
  frozenCommitSha = null,
} = {}) {
  const label = checkpoint || "unknown checkpoint";
  const normalized = normalizeState(state);
  invariant(normalized.headBefore, `A/B source check at ${label} could not read HEAD.`);
  invariant(normalized.headAfter, `A/B source check at ${label} could not re-read HEAD.`);
  invariant(
    normalized.headBefore === normalized.headAfter,
    `A/B source drift at ${label}: HEAD changed while the source check was running.`,
  );
  invariant(
    !normalized.status,
    `A/B source drift at ${label}: tracked or untracked files changed:\n${normalized.status}`,
  );
  if (frozenCommitSha != null) {
    invariant(
      normalized.headAfter === frozenCommitSha,
      `A/B source drift at ${label}: HEAD is ${normalized.headAfter}; expected frozen commit ${frozenCommitSha}.`,
    );
  }
  return normalized.headAfter;
}

export function createGitSourceFreezeGuard({ readState, now = () => new Date().toISOString() }) {
  if (typeof readState !== "function") {
    throw new Error("A/B source freeze guard requires a readState function.");
  }
  let frozenCommitSha = null;
  const checkpoints = [];

  async function record(checkpoint, expectedCommitSha) {
    const state = await readState();
    const commitSha = validateCleanGitSourceState(state, {
      checkpoint,
      frozenCommitSha: expectedCommitSha,
    });
    checkpoints.push(Object.freeze({ checkpoint, commitSha, checkedAt: now() }));
    return commitSha;
  }

  return Object.freeze({
    async freeze(checkpoint = "startup") {
      if (frozenCommitSha != null) {
        throw new Error("A/B source commit has already been frozen.");
      }
      frozenCommitSha = await record(checkpoint, null);
      return frozenCommitSha;
    },

    async assert(checkpoint) {
      if (frozenCommitSha == null) {
        throw new Error("A/B source commit must be frozen before running an arm.");
      }
      await record(checkpoint, frozenCommitSha);
      return frozenCommitSha;
    },

    snapshot() {
      if (frozenCommitSha == null) {
        throw new Error("A/B source commit has not been frozen.");
      }
      return Object.freeze({
        frozenCommitSha,
        checkpoints: Object.freeze(checkpoints.map((entry) => ({ ...entry }))),
      });
    },
  });
}

export async function runSourceFrozenAb({ sourceGuard, runArm, prepareFinal, writeFinal }) {
  if (!sourceGuard || typeof sourceGuard.assert !== "function") {
    throw new Error("A/B execution requires a source freeze guard.");
  }
  if (typeof runArm !== "function" || typeof prepareFinal !== "function" || typeof writeFinal !== "function") {
    throw new Error("A/B execution dependencies are incomplete.");
  }

  async function runCheckedArm(arm) {
    await sourceGuard.assert(`${arm}:start`);
    try {
      return await runArm(arm);
    } finally {
      // collectArm resolves or rejects only after its own finally block stops
      // the local server and child processes, so even a failed arm is checked.
      await sourceGuard.assert(`${arm}:end-after-stop`);
    }
  }

  const control = await runCheckedArm("control");
  await sourceGuard.assert("control-to-treatment");

  const treatment = await runCheckedArm("treatment");

  const prepared = await prepareFinal({ control, treatment });
  await sourceGuard.assert("final-manifest:before-write");
  return writeFinal({ control, treatment, prepared });
}
