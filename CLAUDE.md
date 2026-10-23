<!--
For AI assistants: this file holds durable conventions, not
phase-specific work. If it conflicts with the code, the code is the
source of truth: flag the drift, don't follow stale guidance. A change
that warrants an update here makes it in the same PR.
-->

# Moments

Planning lives on the wayfinder map issue
(`gh issue list --label wayfinder:map`).

## Documents

- `docs/agents/workflow.md`: who decides what, how sessions, tickets
  and PRs run, what agents may do on the Umbrel, and the context
  budget. Read before starting, closing, or reordering work.
- `GLOSSARY.md`: the vocabulary of code, tickets, and reviews.
- `docs/adr/`: decisions that are hard to reverse; a change that
  contradicts one says so.

## Code

- `main.go`: the Go server. It embeds the UI's build, so build `web/`
  (`npm run build`) before any `go` command. Its tests run FFmpeg
  7.1.5, which the Mac lacks, so there they run in the image's `test`
  stage: `docker build -q --target test -t moments-test . && docker run
  --rm -v "$PWD:/src" moments-test go test ./...`.
- `web/`: the UI. shadcn components come in with
  `npx shadcn@4.22.1 add <name>`, then `npx biome check --write`; the
  `shadcn` package stays out of `package.json` (its CSS is copied into
  `web/src/shadcn.css`). A pure module's tests sit beside it as
  `*.test.ts`, run by `npm test` (`node --test`) and left out of `tsc`,
  which has no Node types.
- `web/checks/`: browser checks on the Mac, outside CI, in the system
  WebKit and headless Chrome, both muted. `node web/checks/codec.mjs`
  runs the codec check, and `node web/checks/trimmer.mjs <URL>` the
  Trimmer check, through the host run at that URL.
- `umbrel/host-run.sh start|stop`: this branch's server on the Umbrel
  host, against the real Home mounted read-only, at a localhost URL it
  prints. The test set's paths stay on the Umbrel, out of the repo.
- `Dockerfile`: the image. A `v*` tag publishes it to GHCR
  (`.github/workflows/release.yml`), the `guillem-moments` package in
  Guillem's Apps pins its digest, and `./snapshot.sh <tag>` publishes the
  tag's code to the public `gariasf/moments-app`, as one commit.
- Checks: whatever `.github/workflows/ci.yml` runs.

## Agent skills

### Issue tracker

GitHub Issues for this repo, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`); each label string equals its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Maintenance

Pointers here, reference material behind them. Keep this file short:
the more rules, the faster they drift.

Update it in the same PR when the folder layout changes, a
cross-cutting convention is adopted, an ADR is added or superseded, or
the same correction comes up twice. Don't update it for ticket-specific
work or one-off fixes.

One agent reads this file: Claude Code. No `AGENTS.md`; if a second
agent is onboarded, move the shared content there and keep only
Claude-specific addenda here.
