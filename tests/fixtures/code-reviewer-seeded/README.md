# Seeded-Diff Acceptance Fixture

This fixture is used as the **old-vs-new acceptance gate** for the code-reviewer upgrade.
The new (upgraded) code-reviewer must surface each issue listed below; the old (pre-upgrade)
reviewer is expected to miss the graph-class issues.

## Seeded Issues

### 1. N+1 Query (graph-class)
- **File:** `services/userService.js:14-15`
- **Pattern:** `getUsersWithPosts` calls `repo.findById(id)` and `repo.findPostsByUser(id)`
  inside a `for` loop over `userIds`. Each iteration fires two DB round-trips;
  100 users = 200 queries instead of 2.
- **Expected workstream / optimizer category:** W4 graph-class — N+1 Query;
  confirmed by `graphify path "UserRepository" "getUsersWithPosts"` tracing loop-plus-fetch.
- **Detecting workstream without graph:** W4 file-level — Algorithmic Anti-Patterns
  (ORM call inside a `for` loop body is a concrete signal).

### 2. Cyclic Module Dependency (graph-class)
- **File:** `repos/userRepository.js:3`
- **Pattern:** `userRepository` imports `validateUserId` from `services/userService.js`.
  `userService.js` imports `UserRepository` from `repos/userRepository.js`.
  This creates a cycle: `services → repos → services`.
- **Expected workstream / optimizer category:** W4 graph-class — Architectural Smells
  (cyclic dependency between service and repository layers);
  confirmed by `graphify query "does userRepository create a cycle with userService?"`.

### 3. Quadratic Loop (file-level)
- **File:** `utils/processData.js:6`
- **Pattern:** `findDuplicates` uses a nested `for` loop over the same `items` array —
  O(n²) time. A single pass with a `Set` of seen IDs would be O(n).
- **Expected workstream / optimizer category:** W4 file-level — Algorithmic Anti-Patterns
  (nested loops over the same collection; detectable from diff alone).

### 4. Dead Export (graph-class)
- **File:** `utils/processData.js:19`
- **Pattern:** `legacyTransform` is exported but never imported in any other module
  in this fixture. No callers exist.
- **Expected workstream / optimizer category:** W4 graph-class — Dead Exports;
  confirmed by `graphify affected "legacyTransform"` returning no callers.
  Without graph: flagged as "possible dead export — recommend graphify setup."

## Usage

Point a code-reviewer worker at this fixture as its review target:

```
REPO=tests/fixtures/code-reviewer-seeded bun $ADV/bin/summon code-reviewer
```

A passing acceptance gate requires the reviewer to surface **at least one finding
the old reviewer missed** — specifically a graph-class issue (N+1 or cyclic dep or
dead export) supported by optimizer output or graphify evidence.
