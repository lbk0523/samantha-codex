import { readdir } from "node:fs/promises";
import { join } from "node:path";

const TESTS_DIR = "tests";
const HOST_TESTS = new Set([
  "operations.test.ts",
  "ops-diagnostics.test.ts",
  "telegram-reply-adapter.test.ts",
]);

type TestProfile = "portable" | "host" | "all";

const profile = process.argv[2] as TestProfile | undefined;

if (profile !== "portable" && profile !== "host" && profile !== "all") {
  console.error("Usage: bun run scripts/run-test-profile.ts <portable|host|all>");
  process.exit(2);
}

const files = (await readdir(TESTS_DIR))
  .filter((file) => file.endsWith(".test.ts"))
  .sort();

const selected = files.filter((file) => {
  if (profile === "all") return true;
  if (profile === "host") return HOST_TESTS.has(file);
  return !HOST_TESTS.has(file);
});

if (selected.length === 0) {
  console.error(`No ${profile} tests found.`);
  process.exit(1);
}

const proc = Bun.spawn(
  ["bun", "test", "--path-ignore-patterns=worktrees/**", ...selected.map((file) => join(TESTS_DIR, file))],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exit(await proc.exited);
