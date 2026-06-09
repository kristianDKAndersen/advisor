# Optimizer Category Taxonomy

Reference for the code-reviewer optimizer pass. Ten categories across two tiers.
See `spawns/code-reviewer/CLAUDE.md` for usage in the Optimization Opportunities output section.

---

## Category Table

| # | Category | Concrete Example | LLM-Applicable Detection Signal | Needs Graph Context? | Severity |
|---|----------|-----------------|--------------------------------|----------------------|----------|
| 1 | **Algorithmic / Complexity Anti-Patterns** | Quadratic loop: iterating a list inside a loop over the same list — O(n²) where O(n log n) exists | Nested `for`/`while` over sibling collections; `in list` membership test inside loop (use `set`); repeated `.find()`/`.index()` in loop body; Ruff PERF401 / B023 | N | Critical (unbounded input) / High (DB-backed) |
| 2 | **Redundant Allocation & Computation** | String concatenation in a loop (`result += s`); object/array construction inside a hot loop that could be hoisted; re-computing an invariant expression on every iteration | `+=` on `str`/bytes in loop (use `join`); `new`/`[]`/`{}` inside loop when value is invariant; identical sub-expression 3+ times without assignment; Ruff PERF101, PERF203, PERF402 | N | High in tight loops |
| 3 | **I/O & Resource Inefficiency** | Opening a file or DB connection on every iteration; repeated `readFile`/`HTTP GET` for same resource without caching; unbatched writes (single-row INSERT per loop) | `open()`/`fs.readFileSync()`/`fetch()`/`requests.get()` inside loop body; missing `with` context manager; connection object created per call (no pool); single-row INSERT inside loop | N (single-function patterns); Y (cross-function I/O tracking) | Critical (network); High (disk) |
| 4 | **Complexity & Maintainability Smells** | Method with cyclomatic complexity > 10; function > 50 lines; nesting depth > 4; `if/elif` chain over a type tag that should be polymorphism | Decision-point count (cyclomatic complexity); function LOC; max nesting depth; parameter count > 5; repeated `if type == X`/`isinstance` chains over same variable | N (AST metrics, file-level) | High (correlates with defect density) |
| 5 | **Speculative Generality / Over-Engineering** | Abstract factory with one concrete implementation; interface with a single implementor never substituted; function parameters always called with same literal value | Single-implementor `implements`; abstract base class subclassed exactly once; parameters always called with identical literal; `pass`-only subclasses; Fowler "Lazy Class" | N (single-file); Y (cross-module single-use checks) | Low–Medium |
| 6 | **N+1 Query Anti-Pattern** *(graph-class)* | ORM: `for order in orders: order.user.name` — one SELECT per iteration instead of one JOIN | ORM relation access inside loop body; `session.query()`/`Model.objects.get()`/Prisma `findUnique` inside `for`/`forEach`; absence of `.include()`/`prefetch_related()`/`joinedload()` before loop | **Y** — cross-function ORM calls that resolve inside a caller's loop require call graph | Critical (latency grows linearly) |
| 7 | **Dead Exports / Unused Code** *(graph-class)* | Exported function never imported anywhere; local variable assigned but never read; unreachable branch after `return` | ESLint `no-unused-vars` / `@typescript-eslint/no-unused-vars` (file-level); `import/no-unused-modules` unusedExports; `ts-prune`; Ruff F841; unreachable code after `return`/`raise` | **Y** — exported-symbol deadness requires full import graph across all entry points | Medium–High |
| 8 | **Architectural Smells** *(graph-class)* | Cyclic dependency: `auth` imports `user`, `user` imports `auth`; God object: class with 30+ public methods; layering violation: `infrastructure/db.ts` imported by `presentation/controller.ts` | Cyclic deps via SCC over module import graph; God object: class LOC > 300 or public-method count > 20; layering: import path vs declared layer map | **Y** — all three sub-types require module dependency graph; undetectable from a single file | Critical (cyclics); High (God objects, layering) |
| 9 | **Cross-file Duplication** *(graph-class)* | Identical 10-line block copy-pasted across three service methods; same validation logic in controller and model; near-identical `transformUser`/`transformAdmin` differing only in field set | Exact or near-exact AST subtree clones (Type-1 through Type-3); identical literal strings/magic numbers in 3+ places; sibling functions with identical structure differing by one token | **Y** — cross-module clone detection requires project-wide AST index; same-function clones are file-level | Medium structurally; High when duplicated logic contains a bug |
| 10 | **Feature Envy & Inappropriate Coupling** *(graph-class)* | Method in `OrderService` accesses 5 fields of `Customer` and zero of `Order`; message chain: `order.getCustomer().getAddress().getCity()` | Method body primarily reads/writes fields of a different class than `self`/`this`; chain of 3+ dot-access getters on foreign object (Law of Demeter violation); Fowler "Move Method" signal | **Y** — determining the better home for a method requires knowing the target class's interface | Medium |

---

## Graph-Class Categories (Needs Graph Context = Y)

These five categories produce too many false positives or are structurally undetectable without dependency-graph context. Flag as *possible* and recommend graph-aware verification when graph context is unavailable.

1. **N+1 Query Anti-Pattern** — ORM call and consuming loop frequently live in different functions or layers.
2. **Dead Exports / Unused Code** — a symbol is only provably dead when no import path in any entry point reaches it.
3. **Architectural Smells** — cyclic deps and layering violations are defined over the module dependency graph.
4. **Cross-file Duplication** — near-clone detection across modules requires a project-wide AST index.
5. **Feature Envy / Coupling** — optimal class for a misplaced method requires knowing all candidate class interfaces.

---

## Ruff PERF Anchors

| Rule | Signal | Category |
|------|--------|----------|
| PERF101 | `list(iterable)` where generator suffices | Redundant Allocation |
| PERF203 | `try-except` inside loop (exception overhead per iteration) | Redundant Computation |
| PERF401 | Manual list-append loop replaceable by comprehension | Algorithmic / Redundant Alloc |
| PERF402 | Manual list-copy in loop replaceable by `list.copy()` | Redundant Allocation |
| F841 | Local variable assigned and never used | Dead Exports / Unused Code |
| B023 | Function defined inside loop captures loop variable | Algorithmic Anti-Pattern |

---

## ESLint / ts-prune Dead-Code Anchors

| Signal | Tool | Scope |
|--------|------|-------|
| `no-unused-vars` | ESLint core | File-level |
| `@typescript-eslint/no-unused-vars` | TS-ESLint | File-level |
| `import/no-unused-modules` (unusedExports) | eslint-plugin-import | Whole project import graph |
| `ts-prune` | CLI | Whole project |

---

## Severity Reference

| Severity | Criterion |
|----------|-----------|
| Critical | Affects production latency/throughput proportionally to input size; or blocks release independence |
| High | Measurable runtime cost in realistic workloads; or strongly correlated with defect density |
| Medium | Maintenance cost; slows safe modification; not a runtime bottleneck |
| Low | Cognitive overhead; cleanup opportunity with negligible runtime impact |
