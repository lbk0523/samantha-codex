# Dashboard Dogfood

## Why Worker Work Was Invisible

The browser dashboard used to be a static build from completed run summaries only. A worker that was still running wrote live events to `runs/live/*.jsonl` only when dispatched with `--tmux` or `--live-log`, and those files were not shown on the dashboard.

There are now two observer surfaces:

- Browser dashboard: `bun run samantha dashboard:serve --port=4173`, then open `http://127.0.0.1:4173/` for Overview or `http://127.0.0.1:4173/lane-view` for Lane View. Both pages auto-refresh every 5 seconds; each request rebuilds from local state and `runs/live/*.jsonl`.
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
http://127.0.0.1:4173/lane-view
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

- Overview shows `dashboard-live-observer-dogfood` in the Live Timeline while the task is running, with current operational problems separated from historical run failures.
- Lane View shows the same live events grouped by worker/run lane.
- `tmux attach -t samantha` shows formatted worker events.
- Completed worker run appears under Recent Completed Work after dispatch exits.
