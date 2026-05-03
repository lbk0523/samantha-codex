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
  const searchable = [output, extractCodexJsonlText(output)].filter(Boolean).join("\n");
  const match = searchable.match(RESULT_RE);
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

function extractCodexJsonlText(output: string): string {
  const texts: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as {
        item?: {
          type?: unknown;
          text?: unknown;
        };
      };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        texts.push(event.item.text);
      }
    } catch {
      // Non-JSON diagnostic lines may be mixed into stdout/stderr.
    }
  }
  return texts.join("\n");
}
