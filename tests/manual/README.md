# tests/manual/

Scripts here are manual-only harnesses, not wired into `bun test`. `bunfig.toml`
sets `root = "tests"`, and bun test only discovers `*.test.{js,ts}` files, so
these `.sh` scripts are never picked up automatically — this file exists so
that's explicit rather than implicit.

## poll-test.sh

Manual test harness for `worker-inbox-poll.sh` parsing logic (empty inbox,
terminate, guidance, and mixed message scenarios). Run before and after
editing `worker-inbox-poll.sh` to confirm behavior parity:

```bash
bash tests/manual/poll-test.sh
```

Exits nonzero if any assertion fails.
