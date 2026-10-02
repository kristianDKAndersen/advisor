# mods/

Claude Code "mods" are plugins that hook into Claude Code's own events
(`tool.call`, `session.start`, etc.) to change or observe its behavior. Each
subdirectory here is one mod.

## Running a mod

```bash
claude --plugin-dir mods/write-gate
```

Loads the mod for one interactive session. Repeat the flag to load several
mods at once. The hooks module reloads automatically on save.

## Testing a mod

```bash
claude plugin validate --strict mods/write-gate   # manifest + hooks sanity check
claude plugin test mods/write-gate                # runs *.test.ts under the mod dir
```

`claude plugin test` is a separate test runner from the repo's own `bun test`
suite (see `bunfig.toml`, `root = "tests"`) — a mod's `*.test.ts` files live
under `mods/<name>/tests/` and are not collected by `bun test`.

## Enabling / disabling

Nothing here is enabled for real sessions by default. To try a mod across all
your sessions, add its absolute path to `CLAUDE_CODE_PLUGIN_DIRS` (colon- or
semicolon-separated) in your own `~/.claude/settings.json` `env` block, or
pass `--plugin-dir` per invocation as above. `disableAllHooks` in a settings
file turns every mod off again.

## Mods in this directory

- `write-gate/` — denies any `Write` tool call whose content exceeds 50KB.
- `canary/` — dead-man's switch: writes a per-session heartbeat to `$.store`
  (`hb:<sessionId>`, refreshed every 30s) so a stale heartbeat is visible to
  external tooling when the hooks worker dies outright, and shows one toast
  per mod per session if that mod's `plugin.register` count hits 3, ahead of
  the 3-crash rule that disables every mod.
