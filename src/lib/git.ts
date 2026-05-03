export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly cwd: string,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export async function git(args: string[], cwd: string): Promise<string> {
  const stdout = await gitRaw(args, cwd);
  return stdout.trim();
}

export async function gitRaw(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new GitError(args, cwd, stderr);
  }
  return stdout;
}

export async function gitHead(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd);
}

export async function gitTopLevel(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export async function gitChangedFilesSince(baseRef: string, cwd: string): Promise<string[]> {
  const out = await git(["diff", "--name-only", `${baseRef}..HEAD`], cwd);
  return out.split("\n").filter(Boolean);
}

export async function gitWorkingTreeFiles(cwd: string): Promise<string[]> {
  const out = await gitRaw(["status", "--porcelain=v1", "--untracked-files=all", "-z"], cwd);
  if (!out) return [];
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}
