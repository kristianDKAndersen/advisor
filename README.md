# Advisor

A strong-model orchestrator for multi-agent task decomposition. Advisor receives a user prompt, decomposes it into scoped briefs, summons worker agents via `bin/summon`, observes them through append-only inbox/outbox JSONL channels, and synthesizes their findings into a coherent result. Advisor does not execute work it can delegate.

## Quick start

The authoritative orchestrator spec is `CLAUDE.md` at the repo root. Read it before operating as Advisor or modifying orchestration behavior.

Worker agents live under `agents/<name>/CLAUDE.md`. Each defines its role, allowed tools, and output format. Spawn a worker with:

```bash
bin/summon <agent-name> "<brief>"
```

## Prerequisites

**macOS Terminal.app profile configuration** — required for `bin/close-tab` to work.

Open Terminal.app → Settings → select your default profile → Shell tab → find "When the shell exits" → set to **"Close if the shell exited cleanly"** (or "Close the window").

Why: `bin/close-tab` uses AppleScript (`close t` / `close w`) to terminate a worker's Terminal tab on self-termination. If the profile is set to "Don't close the window", AppleScript closes the window but the tab content remains, and new windows accumulate as zombie sessions after every run. The close-tab integration test (`test/close-tab.test.sh`) cannot pass with that setting.

Symptom if misconfigured: tabs linger showing "Process completed" or "Shell exited" after workers finish.

## Tests

```bash
bash test/close-tab.test.sh
```

Expect: `3/3 PASS`.

## TODO: bootstrap script

The Terminal profile preference above is the only non-repo setup step required to run Advisor. A future `bin/bootstrap` script should automate verification:

1. Verify `osascript` is available (`which osascript`).
2. Read the Terminal profile setting:
   ```bash
   defaults read com.apple.Terminal shellExitAction
   ```
   Expected value: `1` (close if clean exit) or `2` (always close). Value `0` means "Don't close" — misconfigured.
3. Print actionable instructions if the key is missing or set to `0`.

Deferred — do not implement until the rest of the channel/summon tooling stabilizes.
