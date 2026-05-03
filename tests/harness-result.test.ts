import { describe, expect, test } from "bun:test";
import { parseHarnessResult } from "../src/lib/harness-result";

describe("parseHarnessResult", () => {
  test("parses a valid HARNESS_RESULT line", () => {
    const result = parseHarnessResult(
      'work done\nHARNESS_RESULT: {"status":"pass","note":"ok","commit":"abc123"}',
    );

    expect(result).toEqual({ status: "pass", note: "ok", commit: "abc123" });
  });

  test("rejects missing result lines", () => {
    expect(() => parseHarnessResult("no structured result")).toThrow("missing HARNESS_RESULT");
  });

  test("rejects invalid statuses", () => {
    expect(() =>
      parseHarnessResult('HARNESS_RESULT: {"status":"done","note":"ok","commit":"abc123"}'),
    ).toThrow("status must be pass, rework, or blocked");
  });
});
