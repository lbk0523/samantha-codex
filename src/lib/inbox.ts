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
    const command = JSON.parse(await readFile(commandPath, "utf8")) as InboxCommand;
    const report = await input.handle(command);
    const name = basename(file, ".json");
    const outboxPath = join(input.outboxDir, `${name}.md`);
    const archivePath = join(input.archiveDir, file);

    await writeFile(outboxPath, report.endsWith("\n") ? report : `${report}\n`, "utf8");
    await rename(commandPath, archivePath);
    results.push({ commandPath, outboxPath, archivePath });
  }

  return results;
}
