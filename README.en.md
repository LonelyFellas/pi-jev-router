# pi-jev-router

> 中文说明见 [README.md](README.md)。

A pi extension that uses **Jev** (the TypeSafe System One decision model) to characterize the first task of a session and route it to a suitable model and thinking level.

## Install & update

```bash
# npm (registry index can lag a few minutes after a release)
pi install npm:@darwish-yu/pi-jev-router

# git (works immediately)
pi install git:github.com/LonelyFellas/pi-jev-router

# update / list / remove
pi update
pi list
```

For local development use a symlink instead (see "First-time setup" below).

## How it works

```
first user task
  → Jev answers four structured questions (task type / complexity / risk / is the description sufficient)
  → a program matches candidates from a capability table (cheapest candidate that is strong enough)
  → switch model + thinking level, then the task continues
```

- Jev only produces structured answers (Choice / Score / Noul); it never generates text.
- Model capabilities (vision, reasoning, cost tier) live in your config, not in Jev's model knowledge.
- If Jev is unavailable, times out, or no candidate matches, the router falls back to the current model and never blocks the task.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Route and switch on the first task. If the analysis reports the task is under-specified (`sufficient=false`), keep the current model and level and only show the recommendation in the status bar. |
| `shadow` | Show recommendations only, never switch (use it to evaluate routing quality). |
| `locked` | Do nothing; keep the current model. |

## Commands and status

- `/route` or `/route status`: show the mode, the latest decision, whether a user model change was respected (`用户覆盖`), the analysis inputs (task type / sufficiency / confidence), and the last failure category with its elapsed time.
- `/route auto` / `/route lock` / `/route shadow`: switch mode (persisted per session).

The status bar separates recommendation from what is actually in effect: `route(shadow): <model>/<thinking>` is only a suggestion; `route: <model>/<thinking>` is what is actually applied; when the two diverge (switch failed, the user changed the model, or the task was left advisory) it shows `route: <actual> (建议 <recommended>)`.

Model switching and thinking-level changes are applied independently: even when the recommended model is already active, the recommended thinking level is still applied (for example, a complex task on the same model raises `low` to `xhigh`).

## Configuration

Config is read from, in order:

1. `~/.pi/agent/pi-jev-router.json` (global)
2. `<project>/.pi/pi-jev-router.json` (project-local; only for trusted projects)

See `router.config.example.json`. Fields:

- `candidates[].modelRef`: `provider/model-id`, must exist in pi's model catalogue.
- `costTier` 1–5: lower is cheaper; the cheapest candidate that is strong enough wins.
- `strengthTier` 1–5: base capability tier; the thinking level boosts it.
- `thinkingLevel`: the candidate's thinking level (optional), one of `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`. It is a **floor**: a more complex task may raise the level past it (this is how a mid-tier model handles harder work), a simple task never lowers it. The only exception is `off`, which is absolute and never raised. Levels the model does not support are clamped by pi, and the effective level is shown in the status bar and `/route status`.
- `taskTypes`: restrict the task types the candidate fits (optional).
- `insufficientPolicy`: what to do when the analyzer calls the task under-specified. `advisory` (default) keeps the current model and only shows the suggestion; `route` switches anyway.
- `minConfidence`: also leave decisions advisory below this confidence (0–1, default `0` = disabled). Measured over 20 recorded samples, low-confidence groups have a *lower* predicted rework rate than the rest (0% vs 28–33%), so confidence does not predict rework there and the gate stays off by default.
- `jev.apiKey`: credential source (recommended). Supports `$ENV`, `${ENV}`, and `!command`. Never commit a real key. On macOS you can use `!/usr/bin/security find-generic-password -s pi-jev-router -a typesafe -w`.
- `jev.apiKeyEnv`: legacy field; the environment variable holding the TypeSafe API key, default `TYPESAFE_API_KEY`; used when `jev.apiKey` is not set.
- `jev.baseUrl`, `jev.timeoutMs`: Jev endpoint and request timeout.

Safety: the project-local `.pi/pi-jev-router.json` is read only after the project is trusted; a `!command` credential source runs only when a Jev request is made, with a timeout, an output size limit, and a minimized environment, and credentials are redacted from errors. A missing credential falls back to the current model; with only one available model no Jev request is made at all.

## Behavior guarantees and limits

- Routes only the **first user message** of a session; later messages are not re-routed (use `/route` to inspect or change the mode).
- A model you pick while routing is respected (never overwritten); both `/model` and Ctrl+P cycling count as user intervention, while a session-restore selection does not.
- If the first task is cancelled while Jev is analyzing (`ctx.signal` already aborted), no request is sent, no model is switched, and the one-time routing slot is not consumed — the next message is routed again.
- When no candidate could be routed (no candidates configured, none resolve to an available model, or an image task with only text-only candidates), no Jev request is made and the fallback model is used. `taskTypes` depends on the analysis and cannot be checked locally.
- Invalid config is never silently ignored: fields are validated one by one, invalid entries are dropped, unknown keys (e.g. a misspelled `candidate`) are named, and a warning is shown once at session start. Non-finite Jev response numbers are categorized as `invalid-response` instead of silently becoming `NaN`.
- Failures keep only the category, HTTP status, and elapsed time — never the response body, which could echo a truncated or masked credential and would end up persisted in the session and shown in `/route status`.
- Analyzer confidence and sufficiency are recorded and displayed only; the confidence gate is off by default.

## Development

```bash
npm install
npm run typecheck                 # typecheck
npx tsx src/router.test.ts        # pure routing logic
npx tsx src/config.test.ts        # config validation and layered merge (no fs)
npx tsx src/credentials.test.ts   # credential sources (offline)
npx tsx src/jev.test.ts           # cancellation, failure categories, response validation (stubbed fetch)
node --experimental-strip-types src/index.test.ts   # session/routing/override behavior (offline)
npx tsx scripts/eval.ts           # print the evaluation plan (offline)
npx tsx scripts/ab.ts             # print the tier-comparison plan (no model calls)
```

## Evaluation

Two different questions need two different tools:

- `scripts/eval.ts` calibrates the **analyzer and routing-policy inputs** (are complexity/risk/confidence/sufficiency reliable?). It cannot compare model tiers: every task ran on exactly one tier, and cross-task averages are not comparable.
- `scripts/ab.ts` answers **"can this tier be lowered?"** by running the *same* task on two tiers in detached worktrees, recording exit codes, diff size, repo checks (typecheck + all five test scripts), and archiving the full patch per run to `ab-out/diffs/`. Dry run by default; `--run` spends real tokens; `--keep` keeps worktrees.

After a run you must review both patches and fill the `review` column: **passing checks only proves the repo is not broken, not that the task is done.**

The harness is abort-safe and resumable: results append per run, a heartbeat prints while a run is in flight, worktrees are cleaned on SIGINT/SIGTERM, and completed pairs are skipped on the next run.

See the Chinese README for the full detail, including the recorded A/B conclusion that motivated the floor semantics of `thinkingLevel`.
