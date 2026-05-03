import type { HarnessResult, HarnessStatus } from "./contracts";

const RESULT_RE = /^HARNESS_RESULT:\s*(\{.+\})\s*$/m;

export class HarnessResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessResultParseError";
  }
}

function isHarnessStatus(value: unknown): value is HarnessStatus {
  return value === "pass" || value === "rework" || value === "blocked";
}

export function parseHarnessResult(output: string): HarnessResult {
  const match = output.match(RESULT_RE);
  if (!match?.[1]) {
    throw new HarnessResultParseError("missing HARNESS_RESULT line");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new HarnessResultParseError(
      `invalid HARNESS_RESULT json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HarnessResultParseError("HARNESS_RESULT must be a JSON object");
  }

  const result = parsed as Record<string, unknown>;
  if (!isHarnessStatus(result.status)) {
    throw new HarnessResultParseError("HARNESS_RESULT.status must be pass, rework, or blocked");
  }

  return {
    status: result.status,
    note: typeof result.note === "string" ? result.note : "",
    commit: typeof result.commit === "string" ? result.commit : "",
  };
}
