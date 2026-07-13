# Platform-Native Solutions

Adapted from [ponytail](https://github.com/DietrichGebert/ponytail) `docs/platform-native.md`. Before adding a dependency, check here first — only search the web or a package registry if the table has no answer.

The question is always: *does the platform already do this?* The runtime, stdlib, or shell you already have ships with your app for free, doesn't break on updates, and was written by people whose job is exactly that problem.

---

## JS / TS — Node & Bun built-ins

| You think you need | What the platform has |
|---|---|
| `uuid` (v4) | `crypto.randomUUID()` |
| `lodash.clonedeep` | `structuredClone(obj)` |
| `lodash.groupby` | `Object.groupBy(arr, fn)` |
| `mkdirp` / `make-dir` | `fs.mkdirSync(path, { recursive: true })` |
| `rimraf` | `fs.rmSync(path, { recursive: true, force: true })` |
| `path-exists` | `fs.existsSync(path)` |
| `load-json-file` | `JSON.parse(fs.readFileSync(path, "utf8"))` |
| `write-json-file` | `fs.writeFileSync(path, JSON.stringify(obj, null, 2))` |
| `array-uniq` | `[...new Set(arr)]` |
| `array-flatten` / `flat` | `arr.flat(Infinity)` |
| `object-assign` | `Object.assign()` / spread |
| `query-string` / `qs` | `new URLSearchParams(str)` |
| Abort fetch on timeout | `AbortSignal.timeout(5000)` passed to `fetch` |
| Custom event bus | `new EventTarget()` / `dispatchEvent(new CustomEvent(...))` |
| dotenv (Bun projects) | Bun auto-loads `.env` — no package needed |
| Fast package install/run (Bun projects) | `bun install` / `bun run` / `bun x <pkg>` in place of npm+npx |
| Glob matching (Bun projects) | `Bun.Glob` (no `glob`/`fast-glob` package) |
| `ms` (parse duration strings) | keep it — genuinely small and useful, not worth reimplementing |

---

## Python — standard library

| You think you need | What Python has |
|---|---|
| `python-dateutil` (basic parsing) | `datetime.fromisoformat()` (3.7+) |
| `pytz` | `zoneinfo.ZoneInfo("America/New_York")` (3.9+) |
| `attrs` (simple data classes) | `@dataclass` |
| `pathlib2` | `pathlib.Path` (built-in since 3.4) |
| `simplejson` (basic use) | `json` (stdlib) |
| `requests` (simple GET, no auth/retries) | `urllib.request.urlopen(url)`; reach for `requests` once you need real retry/session handling |
| `click` (single command) | `argparse` (stdlib) |
| `mergedeep` | `dict \| other_dict` (3.9+) |
| `more-itertools` (basic) | `itertools`: `chain`, `islice`, `groupby`, `product` |
| `toolz` (basic) | `functools`: `lru_cache`, `partial`, `reduce` |
| `tabulate` (dev/debug only) | `pprint.pprint()` for quick inspection |

---

## Shell / CLI

| You think you need | What the shell/coreutils has |
|---|---|
| `mkdirp` npm package in a shell script | `mkdir -p path` |
| `rimraf` in a shell script | `rm -rf path` |
| `uuid` CLI tool | `uuidgen` (macOS/Linux) |
| Node/Python just to check a binary exists | `command -v <bin>` (POSIX) instead of shelling to `which` |
| Custom temp-file naming logic | `mktemp` / `mktemp -d` |
| JSON parsing via grep/sed/awk | `jq` (already a project dependency here — see `lib/channel.js` usage) |
| Hand-rolled retry loop for a flaky command | shell `until`/`while` with `sleep`, or `timeout <n> <cmd>` to bound it |
| Custom date formatting script | `date -u +%Y-%m-%dT%H:%M:%SZ` (ISO 8601, matches `last_updated_ts` convention) |
| Recursive diff/copy tooling | `diff -r` / `cp -r`; `rsync -a` once you need partial sync or excludes |
| Polling a file until it appears | `until [ -f path ]; do sleep 1; done` instead of a bespoke watcher |

---

## The Pattern

```
Platform team spends years solving the problem.
Package author wraps it.
You install the wrapper.
The wrapper goes unmaintained.
You debug the wrapper.
```

Skip the wrapper. When the native solution is genuinely insufficient (missing retries, missing edge cases, ergonomics that matter at scale), the library earns its place. Install it then, not before.
