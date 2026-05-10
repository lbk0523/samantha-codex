import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionItem, DecisionStore } from "../src/lib/decision-store";

let tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("governed decision approvals", () => {
  test("creates and approves memory_change decisions with memory subject only", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-memory-decision-cli-"));
    tmpRoots.push(root);
    const state = join(root, "state");
    const prompt = "Approve memory write. Diff: Activate M11 governed memory approval path.";

    const createProc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "decisions:create",
        "--kind=memory_change",
        "--subject-type=memory",
        "--subject-id=memory-m11-cli-approval",
        "--title=Approve M11 memory approval path",
        `--prompt=${prompt}`,
        "--risk=high",
        "--created-at=2026-05-10T05:00:00.000Z",
        `--state-dir=${state}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [createStdout, createStderr, createExitCode] = await Promise.all([
      new Response(createProc.stdout).text(),
      new Response(createProc.stderr).text(),
      createProc.exited,
    ]);

    expect({ stdout: createStdout, stderr: createStderr, exitCode: createExitCode }).toMatchObject({ exitCode: 0 });
    const created = JSON.parse(createStdout) as {
      id: string;
      kind?: string;
      subject?: { type?: string; id?: string };
      prompt?: string;
      risk?: string;
    };
    expect(created).toMatchObject({
      kind: "memory_change",
      subject: { type: "memory", id: "memory-m11-cli-approval" },
      prompt,
      risk: "high",
    });

    const storedDecisions = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind?: string; subject?: { type?: string; id?: string } });
    expect(storedDecisions).toEqual([
      expect.objectContaining({
        kind: "memory_change",
        subject: { type: "memory", id: "memory-m11-cli-approval" },
      }),
    ]);

    const approveProc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "decisions:resolve",
        created.id,
        "--resolution=approved",
        "--resolved-at=2026-05-10T05:01:00.000Z",
        "--note=Approved memory-subject decision only.",
        `--state-dir=${state}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [approveStdout, approveStderr, approveExitCode] = await Promise.all([
      new Response(approveProc.stdout).text(),
      new Response(approveProc.stderr).text(),
      approveProc.exited,
    ]);

    expect({ stdout: approveStdout, stderr: approveStderr, exitCode: approveExitCode }).toMatchObject({ exitCode: 0 });
    const resolved = JSON.parse(approveStdout) as { resolvedBy?: string; resolution?: string; subject?: { type?: string; id?: string } };
    expect(resolved).toMatchObject({
      resolvedBy: "bk",
      resolution: "approved",
      subject: { type: "memory", id: "memory-m11-cli-approval" },
    });

    const events = (await readFile(join(state, "governance-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        kind: string;
        riskClass: string;
        summary: string;
        source: { kind: string; id: string };
        subject: { type: string; id: string };
        related?: { decisionIds?: string[] };
      });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "transition_approved",
      riskClass: "high",
      summary: prompt,
      source: { kind: "decision", id: created.id },
      subject: { type: "memory", id: "memory-m11-cli-approval" },
      related: { decisionIds: [created.id] },
    });
    await expect(readFile(join(state, "memory.jsonl"), "utf8")).rejects.toThrow("ENOENT");
  });

  test("records approver timestamp risk class and diff summary in the append-only governance audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "samantha-codex-governed-decision-"));
    tmpRoots.push(root);
    const state = join(root, "state");
    const decision = createDecisionItem({
      kind: "agent_profile_change",
      title: "Approve reviewer model change",
      prompt: "model: gpt-5.5 -> gpt-6",
      risk: "high",
      subject: { type: "agent_profile", id: "codex-reviewer" },
      createdAt: "2026-05-09T00:00:00.000Z",
    });
    await new DecisionStore(join(state, "decisions.jsonl")).append(decision);

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "decisions:resolve",
        decision.id,
        "--resolution=approved",
        "--resolved-at=2026-05-09T00:01:00.000Z",
        "--note=Approved after profile governance review.",
        `--state-dir=${state}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const resolved = JSON.parse(stdout) as { resolvedBy?: string; resolvedAt?: string; risk?: string; prompt?: string };
    expect(resolved).toMatchObject({
      resolvedBy: "bk",
      resolvedAt: "2026-05-09T00:01:00.000Z",
      risk: "high",
      prompt: "model: gpt-5.5 -> gpt-6",
    });

    const events = (await readFile(join(state, "governance-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        actor: string;
        timestamp: string;
        riskClass: string;
        summary: string;
        source: { kind: string; id: string };
      });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "bk",
      timestamp: "2026-05-09T00:01:00.000Z",
      riskClass: "high",
      summary: "model: gpt-5.5 -> gpt-6",
      source: { kind: "decision", id: decision.id },
    });
  });
});
