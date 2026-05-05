# Dashboard Dogfood

## Why Worker Work Was Invisible

The browser dashboard used to be a static build from completed run summaries only. A worker that was still running wrote live events to `runs/live/*.jsonl` only when dispatched with `--tmux` or `--live-log`, and those files were not shown on the dashboard.

There are now two observer surfaces:

- Browser dashboard: `bun run samantha dashboard:serve --port=4173`, then open `http://127.0.0.1:4173/`. Refresh the page while a worker runs; each request rebuilds from local state and `runs/live/*.jsonl`.
- Terminal observer: `tmux attach -t samantha` after dispatching with `--tmux`.

Fallback when tmux is unavailable:

```bash
tail -F runs/live/<run-id>.jsonl | bun run src/samantha.ts live:format
```

## Live Worker Dogfood

Run these from `/home/lbk0523/projects/samantha-codex`.

Terminal 1:

```bash
bun run samantha dashboard:serve --port=4173
```

Open:

```text
http://127.0.0.1:4173/
```

Terminal 2:

```bash
bun run samantha tasks:add references/tasks/dashboard-live-observer-dogfood.json
bun run samantha tasks:dispatch dashboard-live-observer-dogfood \
  --repo-root=/home/lbk0523/projects/samantha-codex \
  --allocate \
  --execute \
  --tmux
```

Terminal 3:

```bash
tmux attach -t samantha
```

Pass criteria:

- Browser dashboard shows `dashboard-live-observer-dogfood` in the Live Workers section while the task is running.
- `tmux attach -t samantha` shows formatted worker events.
- Completed worker run appears under Recent Runs after dispatch exits.

