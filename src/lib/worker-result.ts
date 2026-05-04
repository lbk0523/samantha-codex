import type { HarnessResult, TaskSpec } from "./contracts";
import { gitChangedFilesSince, gitWorkingTreeFiles } from "./git";
import { matchesAnyGlob } from "./glob";
import { HarnessResultParseError, parseHarnessResult } from "./harness-result";

export interface VerifyCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScopeViolation {
  file: string;
  reason: "forbidden" | "outside-target";
  matchedPattern?: string;
}

export interface WorkerResultEvaluation {
  pass: boolean;
  harness?: HarnessResult;
  parseError?: string;
  verifyOverrideReason?: string;
  changedFiles: string[];
  scopeViolations: ScopeViolation[];
  verifyResults: VerifyCommandResult[];
}

async function runVerifyCommand(command: string, cwd: string): Promise<VerifyCommandResult> {
  const child = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { command, exitCode, stdout, stderr };
}

function findScopeViolations(task: TaskSpec, changedFiles: string[]): ScopeViolation[] {
  const violations: ScopeViolation[] = [];

  for (const file of changedFiles) {
    const forbidden = task.forbiddenChanges.find((glob) => matchesAnyGlob(file, [glob]));
    if (forbidden) {
      violations.push({ file, reason: "forbidden", matchedPattern: forbidden });
      continue;
    }

    if (!matchesAnyGlob(file, task.targetFiles)) {
      violations.push({ file, reason: "outside-target" });
    }
  }

  return violations;
}

function sandboxVerifyBlockReason(harness: HarnessResult | undefined, output: string): string | undefined {
  if (harness?.status !== "blocked") return undefined;

  const text = `${harness.note}\n${output}`.toLowerCase();
  const hasPortBindError =
    text.includes("listen eperm") ||
    text.includes("port bind eperm") ||
    (text.includes("eperm") && (text.includes("bind") || text.includes("0.0.0.0:3000")));
  if (hasPortBindError) {
    return "worker sandbox blocked local dev server port bind; Samantha verify commands passed outside worker sandbox";
  }

  const hasPlaywrightWebServerStartup =
    text.includes("playwright") &&
    text.includes("webserver") &&
    text.includes("process from config.webserver was not able to start");
  if (hasPlaywrightWebServerStartup) {
    return "worker sandbox blocked Playwright webServer startup; Samantha verify commands passed outside worker sandbox";
  }

  return undefined;
}

export async function evaluateWorkerResult(input: {
  task: TaskSpec;
  cwd: string;
  baseCommit: string;
  output: string;
}): Promise<WorkerResultEvaluation> {
  let harness: HarnessResult | undefined;
  let parseError: string | undefined;
  try {
    harness = parseHarnessResult(input.output);
  } catch (err) {
    if (err instanceof HarnessResultParseError) {
      parseError = err.message;
    } else {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  const committedFiles = await gitChangedFilesSince(input.baseCommit, input.cwd);
  const workingTreeFiles = await gitWorkingTreeFiles(input.cwd);
  const changedFiles = Array.from(new Set([...committedFiles, ...workingTreeFiles]));
  const scopeViolations = findScopeViolations(input.task, changedFiles);
  const verifyOverrideReason = sandboxVerifyBlockReason(harness, input.output);
  const shouldRunVerify =
    harness?.status === "pass" || (verifyOverrideReason !== undefined && scopeViolations.length === 0);
  const verifyResults =
    shouldRunVerify
      ? await Promise.all(input.task.verifyCommands.map((command) => runVerifyCommand(command, input.cwd)))
      : [];
  const verifyPassed = verifyResults.every((result) => result.exitCode === 0);

  return {
    pass:
      (harness?.status === "pass" || verifyOverrideReason !== undefined) &&
      scopeViolations.length === 0 &&
      verifyPassed,
    harness,
    parseError,
    ...(verifyOverrideReason && verifyPassed ? { verifyOverrideReason } : {}),
    changedFiles,
    scopeViolations,
    verifyResults,
  };
}
