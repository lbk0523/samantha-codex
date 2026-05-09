import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProfile, TaskSpec } from "../src/lib/contracts";
import { git } from "../src/lib/git";
import { secretAccessCapabilityId } from "../src/lib/profile-governance";
import { commitWorkerChanges, executeWorkerDispatch, prepareWorkerDispatch, runCommand, runSetupCommands } from "../src/lib/worker-dispatch";

const agent: AgentProfile = {
  id: "codex-worker",
  role: "writer",
  model: "gpt-5.5",
  writerClass: "writer",
  worktreePolicy: "per-task",
  mergePolicy: "samantha-controlled",
  skillPolicy: {
    requiredBundles: [],
    blockedSkills: [
      "using-git-worktrees",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ],
  },
};

const task: TaskSpec = {
  id: "worker-dispatch-fixture",
  title: "Prepare worker dispatch",
  targetAgent: "codex-worker",
  targetFiles: ["src/lib/worker-dispatch.ts"],
  forbiddenChanges: ["state/**", "worktrees/**"],
  verifyCommands: ["bun test tests/worker-dispatch.test.ts"],
  instructions: "Prepare the worker dispatch command.",
  status: "pending",
};

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-dispatch-"));
  await git(["init"], root);
  await git(["config", "user.email", "samantha@example.local"], root);
  await git(["config", "user.name", "Samantha Test"], root);
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: initial fixture"], root);
  return root;
}

describe("prepareWorkerDispatch", () => {
  test("validates policy and prepares a dry-run command", async () => {
    const prepared = await prepareWorkerDispatch({
      task,
      agent,
      repoRoot: "/repo",
      allocate: false,
    });

    expect(prepared.taskId).toBe(task.id);
    expect(prepared.worktreePath).toBe("/.samantha-worktrees/repo/worker-dispatch-fixture");
    expect(prepared.allocation).toBeUndefined();
    expect(prepared.codex.command).toContain("/.samantha-worktrees/repo/worker-dispatch-fixture");
  });

  test("fails before worktree allocation when safety policy blocks dispatch", async () => {
    await expect(
      prepareWorkerDispatch({
        task: { ...task, forbiddenChanges: [] },
        agent,
        repoRoot: "/repo",
        allocate: false,
      }),
    ).rejects.toThrow("writer tasks must declare forbiddenChanges");
  });

  test("explains missing secret approval without leaking secret names in dispatch errors", async () => {
    const secretName = "OPERATIONS_API_KEY";
    try {
      await prepareWorkerDispatch({
        task,
        agent: {
          ...agent,
          secretAccess: [{ secretName, capabilityId: secretAccessCapabilityId(agent.id, secretName) }],
        },
        repoRoot: "/repo",
        allocate: false,
      });
      throw new Error("expected dispatch to be blocked");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("agent profile codex-worker is missing approved secret capability records: 1 secret grant(s)");
      expect(message).not.toContain(secretName);
    }
  });

  test("does not add git metadata write access on dry-run preparation", async () => {
    const prepared = await prepareWorkerDispatch({
      task,
      agent,
      repoRoot: "/repo",
      allocate: false,
    });

    expect(prepared.codex.command).not.toContain("--add-dir");
  });

  test("does not grant git metadata write access to worker agents", async () => {
    const root = await makeRepo();
    try {
      const writer = await prepareWorkerDispatch({
        task,
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
      });
      const reviewer = await prepareWorkerDispatch({
        task: {
          ...task,
          id: "worker-dispatch-reviewer-fixture",
          targetAgent: "codex-reviewer",
          resultMode: "report",
          targetFiles: [],
          forbiddenChanges: ["**/*"],
        },
        agent: {
          ...agent,
          id: "codex-reviewer",
          role: "reviewer",
          writerClass: "non-writer",
          worktreePolicy: "none",
          mergePolicy: "none",
        },
        repoRoot: root,
        allocate: false,
        worktreesDir: "worktrees",
      });

      expect(writer.codex.command).not.toContain("--add-dir");
      expect(reviewer.codex.command).not.toContain("--add-dir");
      expect(reviewer.worktreePath).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects worktree allocation for non-writer profiles", async () => {
    const root = await makeRepo();
    try {
      await expect(
        prepareWorkerDispatch({
          task: {
            ...task,
            id: "worker-dispatch-reviewer-allocation-fixture",
            targetAgent: "codex-reviewer",
            resultMode: "report",
            targetFiles: [],
            forbiddenChanges: ["**/*"],
          },
          agent: {
            ...agent,
            id: "codex-reviewer",
            role: "reviewer",
            writerClass: "non-writer",
            worktreePolicy: "none",
            mergePolicy: "none",
          },
          repoRoot: root,
          allocate: true,
          worktreesDir: "worktrees",
        }),
      ).rejects.toThrow("agent worktreePolicy none must not allocate worktrees");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures command stdout, stderr, and exit code", async () => {
    const result = await runCommand(["bash", "-lc", "echo out && echo err >&2"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("does not inherit host secret env values into worker commands", async () => {
    const previous = process.env.SAMANTHA_SECRET_LEAK_PROBE;
    process.env.SAMANTHA_SECRET_LEAK_PROBE = "visible";
    try {
      const result = await runCommand(["bash", "-lc", "printf 'secret=%s' \"$SAMANTHA_SECRET_LEAK_PROBE\""]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("secret=");
    } finally {
      if (previous === undefined) {
        delete process.env.SAMANTHA_SECRET_LEAK_PROBE;
      } else {
        process.env.SAMANTHA_SECRET_LEAK_PROBE = previous;
      }
    }
  });

  test("tees command progress to a live log when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-live-log-"));
    try {
      const path = join(root, "live.jsonl");
      const result = await runCommand(["bash", "-lc", "echo out && echo err >&2"], {
        liveLog: {
          path,
          runId: "run-fixture",
          taskId: task.id,
          phase: "worker",
        },
      });
      const raw = await readFile(path, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; text?: string; exitCode?: number });

      expect(result.exitCode).toBe(0);
      expect(events.map((event) => event.type)).toContain("command_start");
      expect(events.find((event) => event.type === "stdout")?.text).toContain("out");
      expect(events.find((event) => event.type === "stderr")?.text).toContain("err");
      expect(events.find((event) => event.type === "command_exit")?.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs setup commands in order inside the worktree", async () => {
    const results = await runSetupCommands(["pwd", "echo ready"], "/tmp");

    expect(results).toHaveLength(2);
    expect(results[0]?.exitCode).toBe(0);
    expect(results[0]?.stdout.trim()).toBe(await realpath("/tmp"));
    expect(results[1]?.stdout.trim()).toBe("ready");
  });

  test("stops setup commands after the first failure", async () => {
    const results = await runSetupCommands(["exit 7", "echo skipped"], "/tmp");

    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).toBe(7);
  });

  test("creates a Samantha-owned commit from evaluated worker files", async () => {
    const root = await makeRepo();
    try {
      await writeFile(join(root, "README.md"), "changed\n", "utf8");

      const result = await commitWorkerChanges({
        task: { ...task, expectedCommitSubject: "test: commit worker files" },
        cwd: root,
        files: ["README.md"],
      });

      expect(result.add.exitCode).toBe(0);
      expect(result.commit.exitCode).toBe(0);
      expect(result.commitHash).toHaveLength(40);
      expect(await git(["log", "-1", "--pretty=%s"], root)).toBe("test: commit worker files");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes report-only worker tasks with no changed files", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env bash\necho 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"report only\",\"commit\":\"\"}'\n",
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "report-only-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["test -f README.md"],
          resultMode: "report",
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.changedFiles).toEqual([]);
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not inherit host secret env values into the Codex worker process", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    const previous = process.env.SAMANTHA_SECRET_LEAK_PROBE;
    process.env.SAMANTHA_SECRET_LEAK_PROBE = "visible";
    try {
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env bash",
          "printf 'secret=%s\\n' \"$SAMANTHA_SECRET_LEAK_PROBE\"",
          "echo 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"report only\",\"commit\":\"\"}'",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "worker-env-isolation-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["test -f README.md"],
          resultMode: "report",
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.command?.stdout).toContain("secret=\n");
      expect(result.command?.stdout).not.toContain("visible");
      expect(result.pass).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.SAMANTHA_SECRET_LEAK_PROBE;
      } else {
        process.env.SAMANTHA_SECRET_LEAK_PROBE = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes report-only specialist tasks with no changed files and no commit", async () => {
    const root = await makeRepo();
    const binDir = await mkdtemp(join(tmpdir(), "samantha-codex-bin-"));
    const fakeCodex = join(binDir, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env bash\necho 'Report artifact: repository status reviewed.'\necho 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"report only\",\"commit\":\"\"}'\n",
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "report-only-specialist-fixture",
          targetAgent: "codex-reviewer",
          targetFiles: [],
          forbiddenChanges: ["**/*"],
          verifyCommands: ["test -f README.md"],
          resultMode: "report",
        },
        agent: {
          ...agent,
          id: "codex-reviewer",
          role: "reviewer",
          writerClass: "non-writer",
          worktreePolicy: "none",
          mergePolicy: "none",
        },
        repoRoot: root,
        allocate: false,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.preparation.worktreePath).toBe(root);
      expect(result.preparation.codex.command).toContain("read-only");
      expect(result.evaluation?.changedFiles).toEqual([]);
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("fails report-only specialist tasks that edit files and does not commit", async () => {
    const root = await makeRepo();
    const binDir = await mkdtemp(join(tmpdir(), "samantha-codex-bin-"));
    const fakeCodex = join(binDir, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env bash",
          "while [ \"$1\" != \"--cd\" ]; do shift; done",
          "shift",
          "cd \"$1\"",
          "echo changed > README.md",
          "echo 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"edited report\",\"commit\":\"\"}'",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "report-only-specialist-edit-fixture",
          targetAgent: "codex-reviewer",
          targetFiles: [],
          forbiddenChanges: ["**/*"],
          verifyCommands: ["test -f README.md"],
          resultMode: "report",
        },
        agent: {
          ...agent,
          id: "codex-reviewer",
          role: "reviewer",
          writerClass: "non-writer",
          worktreePolicy: "none",
          mergePolicy: "none",
        },
        repoRoot: root,
        allocate: false,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.changedFiles).toEqual(["README.md"]);
      expect(result.evaluation?.scopeViolations).toEqual([{ file: "README.md", reason: "outside-target" }]);
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("fails writer tasks that change files outside targetFiles", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env bash",
          "while [ \"$1\" != \"--cd\" ]; do shift; done",
          "shift",
          "cd \"$1\"",
          "echo outside > other.txt",
          "echo 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"outside target\",\"commit\":\"\"}'",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "write-outside-target-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["test -f other.txt"],
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.changedFiles).toEqual(["other.txt"]);
      expect(result.evaluation?.scopeViolations).toEqual([{ file: "other.txt", reason: "outside-target" }]);
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails writer tasks that touch forbidden files even when they are targeted", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env bash",
          "while [ \"$1\" != \"--cd\" ]; do shift; done",
          "shift",
          "cd \"$1\"",
          "mkdir -p state",
          "echo secret > state/secret.txt",
          "echo 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"forbidden change\",\"commit\":\"\"}'",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "write-forbidden-change-fixture",
          targetFiles: ["state/secret.txt"],
          forbiddenChanges: ["state/**"],
          verifyCommands: ["test -f state/secret.txt"],
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.scopeViolations).toEqual([
        { file: "state/secret.txt", reason: "forbidden", matchedPattern: "state/**" },
      ]);
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails writer tasks when Samantha verify commands fail", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env bash",
          "while [ \"$1\" != \"--cd\" ]; do shift; done",
          "shift",
          "cd \"$1\"",
          "echo changed > README.md",
          "echo 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"verify should fail\",\"commit\":\"\"}'",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "write-failed-verify-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["grep -q missing README.md"],
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.verifyResults[0]).toMatchObject({
        command: "grep -q missing README.md",
        exitCode: 1,
      });
      expect(result.commit).toBeUndefined();
      expect(result.pass).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps no-change write worker tasks failing", async () => {
    const root = await makeRepo();
    const fakeCodex = join(root, "fake-codex");
    try {
      await writeFile(
        fakeCodex,
        "#!/usr/bin/env bash\necho 'HARNESS_RESULT: {\"status\":\"pass\",\"note\":\"no change\",\"commit\":\"\"}'\n",
        "utf8",
      );
      await chmod(fakeCodex, 0o755);

      const result = await executeWorkerDispatch({
        task: {
          ...task,
          id: "write-no-change-fixture",
          targetFiles: ["README.md"],
          verifyCommands: ["test -f README.md"],
        },
        agent,
        repoRoot: root,
        allocate: true,
        worktreesDir: "worktrees",
        codexBin: fakeCodex,
      });

      expect(result.evaluation?.changedFiles).toEqual([]);
      expect(result.commit?.add.stderr).toBe("no changed files to commit");
      expect(result.pass).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
