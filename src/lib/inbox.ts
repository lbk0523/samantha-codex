import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface InboxCommand {
  id?: string;
  type: string;
  args?: Record<string, unknown>;
}

export interface InboxProcessResult {
  commandPath: string;
  outboxPath: string;
  archivePath: string;
  ok: boolean;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureReport(file: string, err: unknown): string {
  return [
    `# inbox command failed: ${file}`,
    "",
    "```text",
    errorMessage(err),
    "```",
  ].join("\n");
}

export async function processInbox(input: {
  inboxDir: string;
  outboxDir: string;
  archiveDir: string;
  handle: (command: InboxCommand) => Promise<string>;
}): Promise<InboxProcessResult[]> {
  await Promise.all([
    mkdir(input.inboxDir, { recursive: true }),
    mkdir(input.outboxDir, { recursive: true }),
    mkdir(input.archiveDir, { recursive: true }),
  ]);

  const files = (await readdir(input.inboxDir)).filter((file) => file.endsWith(".json")).sort();
  const results: InboxProcessResult[] = [];

  for (const file of files) {
    const commandPath = join(input.inboxDir, file);
    const name = basename(file, ".json");
    const outboxPath = join(input.outboxDir, `${name}.md`);
    const archivePath = join(input.archiveDir, file);
    let report: string;
    let ok = true;
    let error: string | undefined;

    try {
      const command = JSON.parse(await readFile(commandPath, "utf8")) as InboxCommand;
      report = await input.handle(command);
    } catch (err) {
      ok = false;
      error = errorMessage(err);
      report = failureReport(file, err);
    }

    await writeFile(outboxPath, report.endsWith("\n") ? report : `${report}\n`, "utf8");
    await rename(commandPath, archivePath);
    results.push({ commandPath, outboxPath, archivePath, ok, error });
  }

  return results;
}
