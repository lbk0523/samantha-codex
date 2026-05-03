import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentProfile, TaskSpec } from "./lib/contracts";
import { validateDispatch } from "./lib/policy";
import { prepareCodexDispatch } from "./lib/codex-dispatch";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function validateFixture(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const agent = await readJson<AgentProfile>(
    resolve(root, "references/agent-profiles/codex-worker.json"),
  );
  const task: TaskSpec = {
    id: "fixture-single-writer",
    title: "Validate the first Codex-only safety contract",
    targetAgent: "codex-worker",
    targetFiles: ["src/lib/policy.ts"],
    forbiddenChanges: ["04 Backlog/**", "state/**", "worktrees/**"],
    verifyCommands: ["bun test tests/policy.test.ts"],
    instructions: "Confirm the first safety policy fixture still validates.",
    expectedCommitSubject: "test: validate safety policy fixture",
    status: "pending",
  };

  const plan = validateDispatch(task, agent);
  if (!plan.mayDispatch) {
    throw new Error(`fixture dispatch invalid:\n${plan.violations.join("\n")}`);
  }
  console.log("fixture dispatch valid");
}

async function prepareFixture(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const agent = await readJson<AgentProfile>(
    resolve(root, "references/agent-profiles/codex-worker.json"),
  );
  const task: TaskSpec = {
    id: "fixture-single-writer",
    title: "Validate the first Codex-only safety contract",
    targetAgent: "codex-worker",
    targetFiles: ["src/lib/policy.ts"],
    forbiddenChanges: ["04 Backlog/**", "state/**", "worktrees/**"],
    verifyCommands: ["bun test tests/policy.test.ts"],
    instructions: "No code change is required. Inspect the policy fixture and report whether it is dispatch-safe.",
    expectedCommitSubject: "test: validate safety policy fixture",
    status: "pending",
  };
  const prepared = prepareCodexDispatch(task, agent, resolve(root, "worktrees/fixture-single-writer"));
  console.log(JSON.stringify(prepared.command, null, 2));
}

const command = process.argv[2];

if (command === "validate-fixture") {
  await validateFixture();
} else if (command === "prepare-fixture") {
  await prepareFixture();
} else {
  console.log("usage: bun run src/index.ts validate-fixture|prepare-fixture");
}
