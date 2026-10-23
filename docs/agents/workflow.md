# Workflow

How work moves through this repo. Read before starting, closing, or reordering work.

## Who decides

- The owner decides what is worked on and makes the roadmap decisions: the order of work, a new or superseded ADR, a new dependency or a version bump. Anything that needs the owner's eyes or hands (a visual or interactive check) waits for them too.
- The agent makes every other call itself and states it, with its reason, in the PR body or the ticket. Facts are the agent's job, decisions are the owner's; a question for the owner comes with a recommendation.
- A decision that lives only in chat is not made. It lands as an ADR (`docs/adr/`), a comment on the map issue, or a ticket comment.
- An ADR records a decision that is hard to reverse, surprising without its context, and a real trade-off. Nothing smaller.

## Sessions

The owner types these; the skills are user-invoked as `/mattpocock-skills:<name>`.

| Situation | Start with |
|---|---|
| Decide a map ticket | `/wayfinder #<map>`: a named ticket, or the first frontier one |
| Map clear | `/to-spec`, then `/to-tickets`, in one window |
| Build a ticket | `/implement #<n>` |
| Broken or slow | "diagnose: <symptom>" (the agent runs `diagnosing-bugs`) |
| Unsure | `/ask-matt <situation>` |

- One ticket per session, `/clear` between. A session starts from the ticket body, its linked ADRs and `GLOSSARY.md`; chat history is not a source.
- At most two build sessions at once, each in its own worktree. PRs that touch the same module name their merge order, and the later one rebases onto the earlier.

## Tickets

- A ticket is a tracer bullet: a thin slice, demoable or verifiable on its own, that fits one fresh session. About 400 changed lines at most, not counting lockfiles and generated data; a bigger one splits along a seam. A wide mechanical change goes expand–contract: add the new form, migrate callers in batches, delete the old form.
- Acceptance criteria are the ceiling. Anything a reviewer wants beyond them becomes a note under the map's *Not yet specified*, with the trigger that would revive it.
- The verification seam is agreed before coding (`tdd`).
- Order: blocking edges, then lowest number. Once more than one spec is open, GitHub milestones order the work and every issue gets one.
- Follow-ups: a problem found along the way becomes an issue only when it is critical (a crash, a broken state, wrong data shown as right, a regression) or major (most users meet it in normal use). Everything else goes in the ticket's closing comment under **Seen, not filed**, one line each. Aim for at most one filed follow-up per ticket. A problem inside the ticket's own change is fixed in the ticket.

## Checks

- Measure what the acceptance criteria name, and only that.
- A check that can't run is reported as not run, with the command that would run it.
- Check commands print 30 lines at most on success, and the failing detail on failure.
- Dependencies are pinned. Before writing against a fast-moving API, read the installed version and fetch that version's docs; training data is stale.

## The Umbrel

- Agents reach it as `umbrel@umbrel.local` with the key `~/.ssh/umbrel_moments`. That key reaches root: `umbrel` owns each installed app's compose file and hooks, and umbreld runs them as root.
- So the agent writes only in `/home/umbrel/moments-check/` and `/tmp`, never under `/home/umbrel/umbrel` (Home, app data, app stores, hooks), and never runs anything as root through an app's files. Root comes only from the owner's sudo dialog.

## PRs

- One ticket per PR, opening with `Closes #<n>`. Commit subjects are 72 characters at most; the body says why, not what.
- Before the PR opens, local checks pass and `/code-review` runs against the base branch. Each finding is fixed (correctness, safety, an ADR, or a quick win inside the changed lines; all fixes in one commit), declined (wrong, or beyond the acceptance criteria; one-line reason), or deferred (true but outside the ticket; a *Not yet specified* note with its trigger).
- The body follows the `pr` skill, plus a `## Decide` section: the owner's items, each with a recommendation, or `None`. A visual change shows before and after images.
- Open as a draft; `gh pr ready` once CI passes.
- The agent squash-merges without asking once CI is green and nothing under Decide is open, then removes the worktree and branch. A PR with an owner item waits for the owner.
- A declined finding that recurs becomes a rule: a CI check if it is mechanical, a line in `CLAUDE.md` if it is a judgement call.

## Context and tokens

- Keep an agent's context under about 200k tokens. Past about 400k, write a hand-off file (the state, what's left, where things are), stop, and continue from it in a fresh session.
- Wait on notifications: run long jobs in the background. A `sleep` or `until` loop re-reads the whole context on every poll.
- Keep big outputs out of context: aggregate with scripts, read big files by offset and limit. A subagent's report stays under 250 words; the rest goes in files.
- Research notes live in `docs/research/<topic>.md`, linked from their ticket, so each is read once.
- When done, close browsers, dev servers and Playwright sessions, and remove worktrees.
