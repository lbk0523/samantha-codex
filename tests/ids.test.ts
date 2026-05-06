import { describe, expect, test } from "bun:test";
import { compactEntityId, compactOutboxFileName, readableSlug } from "../src/lib/ids";

describe("compact id helpers", () => {
  test("builds readable ids with a compact timestamp, label, and short hash", () => {
    expect(
      compactEntityId({
        prefix: "action",
        createdAt: "2026-05-06T10:22:00.000Z",
        label: "Recover plan failed result",
        source: "plan-failed-result",
      }),
    ).toBe("action-20260506-102200-recover-plan-failed-result-36278d2f");
  });

  test("keeps slugs short and readable", () => {
    expect(readableSlug("Build Telegram result report UX!!!", 24)).toBe("build-telegram-result");
    expect(readableSlug("abc def ghi", 7)).toBe("abc-def");
  });

  test("builds readable remote outbox filenames", () => {
    expect(
      compactOutboxFileName({
        createdAt: "2026-05-06T10:22:00.000Z",
        kind: "plan-result",
        label: "OMHT onboarding height fix",
        source: "plan-1",
      }),
    ).toBe("remote-20260506-102200-plan-result-omht-onboarding-height-fix-9df3cd54.md");
  });
});
