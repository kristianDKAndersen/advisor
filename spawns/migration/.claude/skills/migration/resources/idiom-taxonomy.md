# Migration Idiom Taxonomy

Reference for the migration worker's `idiomatic_note` field and Commit 2 gate verification.
For each source pattern, the table gives the idiomatic target for Rust, Go, Python, and TypeScript.
See `SKILL.md` Step 5 (Idiomatic rewrite mandate) for usage.

The source language is typically the OLD system language (often C, C++, Java, Python 2, JavaScript, Ruby, or PHP).
Each row names a **source-language pattern** (the anti-pattern or legacy idiom to remove) and the preferred idiom in each target.
For PHP-specific source patterns of the 2016 era (mysql_*, superglobals, mixed HTML+logic, ...), see the dedicated catalog [php-2016-idioms.md](php-2016-idioms.md).

## Contents

- Category Table (10 categories, per-language target idioms)
- Graph-Class Idioms (needs cross-module context)
- Language-Pair Quick Reference
- Idiomatic Note Quality Standard
- Ruff / ESLint / clippy Anchors for Commit 2 Gate Verification

---

## Category Table

| # | Category | Source Pattern (old) | Rust Target Idiom | Go Target Idiom | Python Target Idiom | TypeScript Target Idiom | LLM Detection Signal | Graph Context? | Priority |
|---|----------|---------------------|-------------------|-----------------|--------------------|-----------------------|---------------------|---------------|---------|
| 1 | **Memory / Resource Management** | Manual `malloc`/`free`, reference counting, explicit destructors | Ownership + RAII: `Box<T>`, `Rc<T>`, `Arc<T>`, `Drop`; lifetime annotations replace manual lifetime tracking | GC + `defer` for cleanup; use `sync.Pool` for hot-path reuse; never raw `unsafe.Pointer` without a wrapper type | Context managers (`with` + `__enter__`/`__exit__`); `weakref` for cycles; `functools.lru_cache` instead of manual cache structs | `using` declarations (TS 5.2+) for `Disposable`; no raw `null` as a sentinel for "freed" | `malloc`/`free` calls; `delete`/`delete[]`; explicit ref-count increment/decrement; `__del__` methods | N | Critical (memory safety) |
| 2 | **Null / Absent Value** | Null pointer returns, sentinel `-1`/`""`, nullable without type annotation | `Option<T>` + `?` operator; `unwrap_or`, `unwrap_or_else`, `map`, `and_then`; never raw `unwrap()` in library code | Zero-value convention: `""`, `0`, `nil` as the "empty" case; `(value, bool)` return for optional lookup; `sql.NullString` for DB nils | `Optional[T]` + walrus operator (`:=`); `None` checks via `is None`; `x or default` only when `x` is not a numeric type that could be `0` | `T \| undefined` in return types; nullish coalescing (`??`); optional chaining (`?.`); never `!` (non-null assertion) in library code | `return null`, `== null`, `=== undefined`, sentinel returns (`return -1`) | N | High |
| 3 | **Error Handling** | Return code errors (`errno`, `int return`), exception spaghetti, bare `raise` / `throw` | `Result<T, E>` + `?` propagation; typed error enums instead of string errors; `thiserror` / `anyhow` for library/binary distinction | `(value, error)` tuples; wrap errors with `fmt.Errorf("context: %w", err)`; never swallow `err` with `_`; `errors.Is`/`errors.As` for inspection | Specific exception types (not bare `except Exception`); context chaining with `raise X from Y`; structured logging of error context | `Result<T, E>` type (fp-ts) or typed `Error` subclasses; `never` for exhaustive switch; avoid `try/catch` for control flow | Bare `catch (e)`, untyped `except:`, `errno` checks, `return -1` on error | N | High |
| 4 | **Concurrency / Parallelism** | Threads + mutexes, global locks, `threading.Thread`, callback hell, `pthread` | Ownership-based concurrency: `Arc<Mutex<T>>`; channels (`mpsc::channel`); `tokio::spawn` / `async`/`await` for I/O-bound; `rayon::par_iter()` for CPU-bound | Goroutines + channels (`chan`); `sync.WaitGroup`; `context.Context` for cancellation propagation; `sync.Mutex` only when channels don't fit | `asyncio.gather` / `async`/`await` for I/O; `concurrent.futures.ProcessPoolExecutor` for CPU; `threading.Lock` only when necessary; `asyncio.Queue` for producer-consumer | `Promise.all` / `async`/`await`; `Worker` threads for CPU-bound; `AbortController` for cancellation; `AsyncGenerator<T>` for streams | `pthread_create`, `threading.Thread(`, `new Thread(`, `setInterval`+`clearInterval` for producer-consumer, callback chains >2 deep | N (single-file) / Y (cross-module async chains) | High |
| 5 | **Collections & Iteration** | Imperative index loops (`for i=0; i<n; i++`), manual accumulation, `ArrayList` with capacity pre-alloc, C-style array pointer arithmetic | Iterator chains: `.map()`, `.filter()`, `.fold()`, `.collect()`; `Vec::with_capacity` when size known; iterators are lazy (no allocation until `.collect()`); `HashMap` over sorted `Vec` for lookup | Range loops (`for v := range slice`); `append`; `make([]T, 0, cap)` for pre-alloc; `map[K]V` for lookup; avoid manual index except where index is meaningful | List comprehensions; generator expressions (lazy); `dict` / `set` comprehensions; `itertools` for complex pipelines; `enumerate` not `range(len(x))` | `Array.from`, `.map()`, `.filter()`, `.reduce()`; `for...of` over `for...in`; `Map<K,V>` / `Set<T>` over plain objects for collections; `ReadonlyArray<T>` for invariant data | Index `for` loops with accumulator; `ArrayList.add` in loop; `array.push` in loop without `map/filter` | N | Medium |
| 6 | **Type System & Polymorphism** | Class inheritance hierarchies, duck typing without types, instanceof chains, union types as enum integers | Traits for shared behavior; trait objects (`dyn Trait`) for runtime dispatch; enums with data (`enum Msg { Quit, Move{x,y} }`) instead of class hierarchies; derive macros (`#[derive(Debug, Clone)]`) | Interfaces for behavior contracts; interface satisfaction is implicit; struct embedding for composition; `any` only when truly needed; type switches over interface for runtime dispatch | `Protocol` (structural subtyping) instead of ABC; `@dataclass` instead of manual `__init__`; `TypeVar` for generic functions; `TypedDict` for dict shapes | Interfaces + generics; discriminated unions (`type Shape = Circle \| Square`); `satisfies` operator; `as const` for literal types; no class inheritance where interfaces + composition fit | `isinstance` chains, `if type(x) == Y`, `switch(obj.type)`, casting via `as X` in TS, abstract class with single subclass | N (single-file); Y (cross-module interface usage) | High |
| 7 | **Async / I/O** | Blocking I/O in sync context, callback pyramid, `XMLHttpRequest`, `fs.readFileSync` in hot path, `requests.get` without session | `tokio::fs`, `reqwest::Client` (shared); `async fn` + `await`; `tokio::select!` for concurrent futures; `BufReader`/`BufWriter` for buffered I/O | `http.Client` (reused, not per-call); `io.Reader`/`io.Writer` interfaces; `bufio.Scanner` for line-by-line; `context.Context` on every network call | `aiohttp.ClientSession` (shared); `asyncio.open_connection`; `aiofiles` for file I/O in async context; `httpx.AsyncClient` for HTTP | `fetch` (not `XMLHttpRequest`); shared `axios` instance / `fetch` with `AbortSignal`; `fs/promises` not `fs.readFileSync`; `ReadableStream` for large payloads | `fs.readFileSync` in loop, `requests.get(` without session, `XMLHttpRequest`, callback nesting >2 deep | N | High (latency) |
| 8 | **Configuration & Initialization** | Global mutable state, singleton pattern, module-level side effects on import, god objects with 30+ fields | Dependency injection via struct fields; `once_cell::Lazy` / `std::sync::OnceLock` for lazy init; builder pattern for complex config; no global `static mut` | `config` struct passed via `context.Context`; `sync.Once` for singleton init; `flag` / `viper` for CLI config; avoid `init()` with side effects | `dataclass` + `__post_init__` validation; `pydantic.BaseSettings` for env-based config; avoid module-level global mutation; `functools.cached_property` | `class Config` with `readonly` fields; dependency injection via constructor; `zod` for runtime config validation; avoid module-level mutable state | `var global = ...` at module level, singleton classes, `__init__.py` with side effects, `global` keyword in function | N (single-file); Y (cross-module global access) | Medium |
| 9 | **String & Data Serialization** | String concatenation in loop, manual JSON string building, `sprintf` for all formatting, byte array manual encoding | `format!` / `write!` macros; `serde` for JSON/YAML/TOML; `String::with_capacity` when size known; `Cow<str>` to avoid cloning when borrowing suffices | `fmt.Sprintf` for formatting; `encoding/json` with struct tags; `strings.Builder` for loop concatenation; `bufio.Writer` for stream output | f-strings (not `%` or `.format()` for new code); `json.dumps`/`json.loads`; `dataclasses.asdict`; `str.join` not `+=` in loop | Template literals; `JSON.stringify`/`JSON.parse`; `zod` schema for safe parse; avoid `string + string` in hot paths (use array join) | `result += str` in loop, `sprintf`/`printf` for JSON building, manual base64/hex encoding, `str.format(` for complex templates | N | Medium |
| 10 | **Testing Patterns** | `print`-based debugging left in tests, implicit test ordering dependencies, test-global mutable state, integration tests as the only safety net | `#[cfg(test)]` modules; `assert!`/`assert_eq!` macros; property-based with `proptest`; `mockall` for trait mocking; `tokio::test` for async; doc-tests for examples | `testing.T`; table-driven tests (`[]struct{ input, want }`); `t.Helper()` for assertion helpers; `httptest.NewServer` for HTTP mocks; `testify` for assertions | `pytest` with fixtures; parametrize via `@pytest.mark.parametrize`; `unittest.mock.patch` for mocking; `hypothesis` for property-based; `pytest-asyncio` for async | `describe`/`it` (Jest/Vitest); `beforeEach` for setup; `vi.mock`/`jest.mock` for modules; `@testing-library` for UI; `supertest` for HTTP; `zod.parse` in tests for type safety | `print` in test body, test functions calling each other, `global.state = X` before test, tests that only run in a specific order | N | High (defect detection) |

---

## Graph-Class Idioms (needs cross-module context)

These patterns are detectable from a single file in their source form but require import graph context to confirm the correct target idiom:

1. **Cross-module singleton state** (Category 8): Is the global accessed from one module or twenty? A single-module global can be a closure; a twenty-module global needs DI.
2. **Trait object vs generics** (Category 6): `dyn Trait` is correct when the concrete type is unknown at compile time (plugins, heterogeneous collections). Static dispatch (generics) is correct when the type is known — the graph tells you which.
3. **Channel vs mutex** (Category 4): Use channels when data ownership transfers between goroutines/tasks; use mutex when data is shared in-place. Cross-module ownership analysis needed for large state machines.
4. **Iterator vs stream** (Category 7): A local iterator is fine; an iterator that crosses async boundaries needs a `Stream` (Rust) or `AsyncIterator` (TS/Python). Detectable only with call-graph context.

---

## Language-Pair Quick Reference

The most common migration paths and their highest-priority idioms (top 3 per pair):

| Source → Target | #1 idiom | #2 idiom | #3 idiom |
|---|---|---|---|
| C → Rust | Ownership + RAII (Cat 1) | `Result<T,E>` (Cat 3) | Trait objects vs structs (Cat 6) |
| Python 2/3 sync → Python async | `asyncio` / `aiohttp` (Cat 7) | `async`/`await` + `asyncio.gather` (Cat 4) | f-strings + type annotations (Cat 9) |
| Java/Kotlin → Go | Interface implicit satisfaction (Cat 6) | `(value, error)` returns (Cat 3) | Goroutines + channels (Cat 4) |
| JavaScript → TypeScript | Discriminated unions (Cat 6) | `T \| undefined` / `??` (Cat 2) | `async`/`await` + `AbortSignal` (Cat 7) |
| Ruby/PHP → Python | `@dataclass` + `Protocol` (Cat 6) | `with` context managers (Cat 1) | `pytest` parametrize (Cat 10) |
| JavaScript (callbacks) → TypeScript (async) | `async`/`await` (Cat 7) | `Promise.all` (Cat 4) | Template literals (Cat 9) |
| C++ → Rust | Ownership + RAII (Cat 1) | `Option<T>` (Cat 2) | Iterator chains (Cat 5) |
| Python sync → Rust | `Result<T,E>` (Cat 3) | Ownership model (Cat 1) | `serde` serialization (Cat 9) |
| Legacy PHP → any target | Parameterized data-access (php-2016 P1) | Request-boundary DTOs (php-2016 P3) | Typed records from array shapes (php-2016 P7) |

For the PHP source-side detail behind that last row, see [php-2016-idioms.md](php-2016-idioms.md).

---

## Idiomatic Note Quality Standard

A valid `idiomatic_note` for a migration slice must:
1. **Name a specific language feature** — not a general principle. "Use Rust idioms" fails; "use `impl Iterator<Item=T>` instead of returning `Vec<T>` to keep iteration lazy" passes.
2. **Reference a concrete library or standard library facility** when one exists — "use `serde_json::Value` for dynamic JSON parsing instead of manual string splitting" is verifiable; "parse JSON idiomatically" is not.
3. **Map to a category in this table** (or a pattern in [php-2016-idioms.md](php-2016-idioms.md)) — the coder can look up the exact pattern and confirm the migration satisfies it.
4. **Be verifiable by grep or AST check** — the Commit 2 gate must be able to confirm the idiom is present. "Uses ownership semantics" is not verifiable; "`Arc<Mutex<T>>` present in the type signature" is.

**Anti-patterns (reject these as idiomatic notes):**
- "Translate directly" — this is a plan failure.
- "Use idiomatic Rust/Go/Python" — too vague; names no specific feature.
- "Refactor as needed" — open-ended, not a gate criterion.
- "Similar to S003" — cross-slice reference, not self-contained.

---

## Ruff / ESLint / clippy Anchors for Commit 2 Gate Verification

| Target | Tool | Rule | Idiom category |
|--------|------|------|---------------|
| Python | Ruff PERF101 | `list(iterable)` where generator suffices | Cat 5: Collections |
| Python | Ruff PERF401 | Manual list-append loop → comprehension | Cat 5: Collections |
| Python | Ruff UP006 | `Optional[X]` → `X \| None` (Python 3.10+) | Cat 2: Null safety |
| Python | Ruff ASYNC | Blocking I/O in async context | Cat 7: Async I/O |
| Rust | clippy::option_map_unwrap_or | `.map(...).unwrap_or(...)` → `.map_or(...)` | Cat 2: Null safety |
| Rust | clippy::redundant_clone | unnecessary `.clone()` calls | Cat 1: Memory |
| Rust | clippy::iter_next_loop | `for x in iter.next()` → direct iteration | Cat 5: Collections |
| Go | staticcheck SA4006 | unused variable (likely leftover from literal phase) | Cat 5: Collections |
| TypeScript | @typescript-eslint/no-non-null-assertion | `!` usage | Cat 2: Null safety |
| TypeScript | @typescript-eslint/prefer-nullish-coalescing | `\|\|` → `??` for nullish check | Cat 2: Null safety |

Run the applicable linter as the final step of the Commit 2 gate (after equivalence tests pass) to confirm idiom adoption:

```bash
# Rust:
cargo clippy -- -D warnings

# Python:
ruff check <target_location> --select PERF,UP,ASYNC

# TypeScript:
npx eslint <target_location> --rule '{"@typescript-eslint/no-non-null-assertion": "error"}'

# Go:
staticcheck ./...
```
