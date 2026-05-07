import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecisionItem } from "../src/lib/decision-store";

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "samantha-codex-remote-approval-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

describe("remote approval inbox flow", () => {
  test("approves only the single pending plan decision without exposing ids", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const decision = createDecisionItem({
      title: "Review plan: Mobile approval",
      prompt: "Approve, revise, or cancel before dispatch.",
      kind: "orchestrator_plan_approval",
      source: "system",
      subject: { type: "orchestrator_plan", id: "plan-mobile-approval" },
      createdAt: "2026-05-07T11:00:00.000Z",
    });
    await writeFile(join(state, "decisions.jsonl"), `${JSON.stringify(decision)}\n`, "utf8");
    await writeFile(
      join(inbox, "remote-approve.json"),
      JSON.stringify({
        id: "remote-approve",
        type: "decisions:approve-latest",
        args: { source: "remote", receivedAt: "2026-05-07T11:02:00.000Z" },
      }),
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const report = await readFile(join(outbox, "remote-approve.md"), "utf8");
    expect(report).toContain("# approve");
    expect(report).toContain("텔레그램: `/go`");
    expect(report).not.toContain(decision.id);
    const decisions = (await readFile(join(state, "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; resolution?: string; resolutionNote?: string });
    expect(decisions[0]).toMatchObject({
      status: "resolved",
      resolution: "approved",
      resolutionNote: "Approved via Telegram /approve.",
    });
  });

  test("redirects Telegram approval when more than one decision is pending", async () => {
    const root = await makeRoot();
    const state = join(root, "state");
    const inbox = join(root, "inbox");
    const outbox = join(root, "outbox");
    const archive = join(root, "archive");
    await mkdir(state, { recursive: true });
    await mkdir(inbox, { recursive: true });
    const decisions = ["A", "B"].map((title, index) =>
      createDecisionItem({
        title: `Review plan: ${title}`,
        prompt: "Approve, revise, or cancel before dispatch.",
        kind: "orchestrator_plan_approval",
        source: "system",
        subject: { type: "orchestrator_plan", id: `plan-${index}` },
        createdAt: `2026-05-07T11:0${index}:00.000Z`,
      }),
    );
    await writeFile(join(state, "decisions.jsonl"), decisions.map((decision) => JSON.stringify(decision)).join("\n") + "\n", "utf8");
    await writeFile(
      join(inbox, "remote-approve.json"),
      JSON.stringify({ id: "remote-approve", type: "decisions:approve-latest", args: { source: "remote" } }),
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "src/samantha.ts",
        "inbox:process",
        `--state-dir=${state}`,
        `--inbox-dir=${inbox}`,
        `--outbox-dir=${outbox}`,
        `--archive-dir=${archive}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    const report = await readFile(join(outbox, "remote-approve.md"), "utf8");
    expect(report).toContain("Telegram approval is only allowed when exactly one plan approval decision is pending.");
    expect(report).toContain("CLI 또는 dashboard");
    expect(report).not.toContain("decision-");
    const raw = await readFile(join(state, "decisions.jsonl"), "utf8");
    expect(raw).not.toContain('"status":"resolved"');
  });
});
