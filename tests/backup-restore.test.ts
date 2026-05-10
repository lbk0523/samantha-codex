import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBackupManifest,
  validateHostMigration,
  validateRestore,
} from "../src/lib/backup-restore";
import {
  createRoutineTriggerObservation,
  createRoutineTriggerRecord,
} from "../src/lib/routine-trigger-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-backup-restore-"));
  tmpRoots.push(root);
  await mkdir(join(root, "state"), { recursive: true });
  await mkdir(join(root, "references", "project-profiles"), { recursive: true });
  await writeHostOwnership(join(root, "state", "host-ownership.json"), "host-a");
  await writeFile(
    join(root, "references", "project-profiles", "samantha.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "samantha",
      repoRoot: "$HOME/projects/samantha-codex",
      keywords: ["samantha"],
      setupCommands: ["bun install"],
      verifyCommands: ["bun typecheck"],
      forbiddenChanges: ["state/**"],
    }),
    "utf8",
  );
  return root;
}

async function writeHostOwnership(path: string, hostId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      role: "active_automation_host",
      hostId,
      updatedAt: "2026-05-10T01:00:00.000Z",
      ...extra,
    }),
    "utf8",
  );
}

async function writeJsonl(path: string, records: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("backup, restore, and host migration drills", () => {
  test("generates deterministic manifest entries with restore authority disabled", async () => {
    const root = await makeRoot();
    await writeJsonl(join(root, "state", "tasks.jsonl"), [
      {
        schemaVersion: 1,
        id: "task-1",
        title: "Back up state",
        targetAgent: "codex-worker",
        targetFiles: ["src/lib/backup-restore.ts"],
        forbiddenChanges: ["state/**"],
        verifyCommands: ["bun test"],
        instructions: "Fixture.",
        status: "pending",
      },
    ]);

    const first = await buildBackupManifest({
      root,
      generatedAt: "2026-05-10T02:00:00.000Z",
    });
    const second = await buildBackupManifest({
      root,
      generatedAt: "2026-05-10T02:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.path)).toEqual([...first.entries.map((entry) => entry.path)].sort());
    expect(first.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "state/host-ownership.json", kind: "host_ownership" }),
        expect.objectContaining({ path: "state/tasks.jsonl", kind: "state_record" }),
        expect.objectContaining({ path: "references/project-profiles/samantha.json", kind: "project_profile" }),
      ]),
    );
    expect(first.notes.restoreAuthority).toEqual({
      dispatch: false,
      approve: false,
      merge: false,
      push: false,
      cleanup: false,
      recover: false,
      rewriteHistory: false,
    });
  });

  test("restore validation catches missing manifest files without mutating state", async () => {
    const root = await makeRoot();
    const manifest = await buildBackupManifest({
      root,
      generatedAt: "2026-05-10T02:00:00.000Z",
    });
    const manifestPath = join(root, "manifest.json");
    const stateBefore = await readFile(join(root, "state", "host-ownership.json"), "utf8");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await unlink(join(root, "references", "project-profiles", "samantha.json"));

    const result = await validateRestore({
      root,
      manifestPath,
      currentHostId: "host-a",
      checkedAt: "2026-05-10T02:05:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "missing_file",
        path: "references/project-profiles/samantha.json",
      }),
    );
    expect(await readFile(join(root, "state", "host-ownership.json"), "utf8")).toBe(stateBefore);
    expect(result.authority).toMatchObject({ dispatch: false, approve: false, merge: false, push: false });
  });

  test("restore validation catches malformed records and duplicate ids", async () => {
    const root = await makeRoot();
    const decision = {
      schemaVersion: 1,
      id: "decision-1",
      status: "pending",
      kind: "manual",
      title: "Fixture",
      prompt: "Fixture?",
      options: ["approve", "reject"],
      source: "local",
      createdAt: "2026-05-10T02:00:00.000Z",
      updatedAt: "2026-05-10T02:00:00.000Z",
    };
    await writeJsonl(join(root, "state", "decisions.jsonl"), [decision, decision]);
    await writeFile(join(root, "state", "tasks.jsonl"), "{bad json}\n", "utf8");

    const result = await validateRestore({
      root,
      currentHostId: "host-a",
      checkedAt: "2026-05-10T02:05:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_id", path: "state/decisions.jsonl" }),
        expect.objectContaining({ code: "malformed_record", path: "state/tasks.jsonl" }),
      ]),
    );
  });

  test("restore validation catches broken materialized ancestry and run lifecycle gaps", async () => {
    const root = await makeRoot();
    await writeJsonl(join(root, "state", "orchestrator-plans.jsonl"), [
      {
        schemaVersion: 1,
        id: "plan-1",
        ancestry: { mode: "assigned", projectId: "samantha", goalId: "goal-1", workItemId: "work-1" },
        requestId: "request-1",
        status: "materialized",
        createdAt: "2026-05-10T02:00:00.000Z",
        taskIds: ["task-1"],
        actionIds: ["action-1"],
      },
    ]);
    await writeJsonl(join(root, "state", "tasks.jsonl"), [
      {
        schemaVersion: 1,
        id: "task-1",
        ancestry: { mode: "assigned", projectId: "other", goalId: "goal-1", workItemId: "work-1" },
        title: "Wrong project",
        targetAgent: "codex-worker",
        targetFiles: ["src/lib/backup-restore.ts"],
        forbiddenChanges: ["state/**"],
        verifyCommands: ["bun test"],
        instructions: "Fixture.",
        status: "completed",
      },
    ]);
    await writeJsonl(join(root, "state", "remote-actions.jsonl"), [
      {
        schemaVersion: 1,
        id: "action-1",
        ancestry: { mode: "assigned", projectId: "samantha", goalId: "goal-1", workItemId: "work-1" },
        kind: "dispatch_task",
        status: "completed",
        createdAt: "2026-05-10T02:00:00.000Z",
        source: "remote",
        taskId: "task-1",
        taskTitle: "Wrong project",
        targetAgent: "codex-worker",
        repoRoot: "$HOME/projects/samantha-codex",
        allocate: true,
        execute: true,
        tmux: true,
        result: { runId: "run-missing", pass: true },
      },
    ]);
    await writeJsonl(join(root, "state", "run-lifecycle.jsonl"), [
      {
        schemaVersion: 1,
        runId: "run-missing",
        taskId: "task-1",
        repoRoot: "$HOME/projects/samantha-codex",
        runLogPath: "runs/run-missing.json",
        commit: "abc123",
        cleanedAt: "2026-05-10T02:30:00.000Z",
        updatedAt: "2026-05-10T02:30:00.000Z",
      },
    ]);

    const result = await validateRestore({
      root,
      currentHostId: "host-a",
      checkedAt: "2026-05-10T02:05:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "broken_ancestry" }),
        expect.objectContaining({ code: "run_lifecycle_gap", message: expect.stringContaining("missing run") }),
        expect.objectContaining({ code: "run_lifecycle_gap", message: expect.stringContaining("cleaned before push") }),
      ]),
    );
  });

  test("restore validation catches governance gaps and stale host ownership", async () => {
    const root = await makeRoot();
    await writeHostOwnership(join(root, "state", "host-ownership.json"), "host-a", {
      expiresAt: "2026-05-10T01:59:59.000Z",
    });
    await writeJsonl(join(root, "state", "memory.jsonl"), [
      {
        schemaVersion: 1,
        id: "memory-1",
        revisionId: "memory-revision-1",
        governanceEventIds: ["gov-event-missing"],
      },
    ]);

    const result = await validateRestore({
      root,
      currentHostId: "host-a",
      checkedAt: "2026-05-10T02:05:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "governance_gap", message: expect.stringContaining("gov-event-missing") }),
        expect.objectContaining({ code: "stale_host_ownership", message: expect.stringContaining("expired") }),
      ]),
    );
  });

  test("restore validation parses routine triggers and observations", async () => {
    const root = await makeRoot();
    const trigger = createRoutineTriggerRecord({
      triggerId: "daily-review",
      sourceKind: "schedule",
      projectId: "samantha",
      enabled: true,
      riskClass: "medium",
      sourceEvidence: ["docs/CONTINUOUS_24_7_OPERATIONS.md M11"],
      fingerprintInputs: [{ key: "cadence", value: "daily" }],
      activationDecisionId: "decision-missing-routine-activation",
      createdAt: "2026-05-10T02:00:00.000Z",
    });
    const observation = {
      ...createRoutineTriggerObservation({
        trigger,
        observedAt: "2026-05-10T02:05:00.000Z",
      }),
      routineId: "routine-missing",
    };
    await writeJsonl(join(root, "state", "routine-triggers.jsonl"), [trigger]);
    await writeJsonl(join(root, "state", "routine-trigger-observations.jsonl"), [observation]);

    const result = await validateRestore({
      root,
      currentHostId: "host-a",
      checkedAt: "2026-05-10T02:10:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "governance_gap",
          path: "state/routine-triggers.jsonl",
          message: expect.stringContaining("activation governance is invalid"),
        }),
        expect.objectContaining({
          code: "broken_ancestry",
          path: "state/routine-trigger-observations.jsonl",
          message: expect.stringContaining("references missing trigger"),
        }),
      ]),
    );
  });

  test("migration validation blocks active-active host operation", async () => {
    const root = await makeRoot();
    const oldHost = join(root, "old-host-ownership.json");
    const newHost = join(root, "new-host-ownership.json");
    await writeHostOwnership(oldHost, "old-host");
    await writeHostOwnership(newHost, "new-host");

    const blocked = await validateHostMigration({
      oldHostOwnershipPath: oldHost,
      newHostOwnershipPath: newHost,
      targetHostId: "new-host",
      checkedAt: "2026-05-10T02:05:00.000Z",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.issues).toContainEqual(
      expect.objectContaining({ code: "active_active_host" }),
    );

    await writeHostOwnership(oldHost, "old-host", { role: "client_machine" });
    const allowed = await validateHostMigration({
      oldHostOwnershipPath: oldHost,
      newHostOwnershipPath: newHost,
      targetHostId: "new-host",
      checkedAt: "2026-05-10T02:05:00.000Z",
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.issues).toEqual([]);
  });
});
