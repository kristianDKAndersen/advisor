# calibration.md — porter stemming vs. unicode61, measured on the real vault corpus

Produced for the debt marker at `lib/vault.js:562`. **Read-only exercise.** The live vault
(`~/.advisor/vault/.cache/vault.db`) was never written, dropped, or reindexed; `lib/vault.js`
was not edited. All experimentation happened in a throwaway SQLite copy in scratchpad.

## 1. Method

1. Snapshotted the live vault DB with SQLite's online backup API (read-only on the source,
   does not checkpoint/mutate it):
   `sqlite3 ~/.advisor/vault/.cache/vault.db ".backup '<scratchpad>/calib/throwaway.db'"`.
   Row count matched the live DB exactly at backup time (1921 notes both sides).
2. In the throwaway copy only, added a second FTS5 table indexing the same content with
   porter stemming layered on unicode61 (mirrors how SQLite's `tokenize='porter unicode61'`
   is normally wired):
   ```sql
   CREATE VIRTUAL TABLE notes_fts_porter USING fts5(
     path UNINDEXED, body, routing, content='notes', content_rowid='rowid',
     tokenize='porter unicode61');
   INSERT INTO notes_fts_porter(rowid, path, body, routing)
     SELECT rowid, path, body, routing FROM notes;
   ```
   The existing `notes_fts` (unicode61, no stemming — the live schema, untouched) served as
   the "current" side of every comparison.
3. Built 10 queries in the exact shape the advisor actually issues at CLAUDE.md Step 5
   (`bin/advisor-vault search --text '<3 keywords from task type>'`), reproducing
   `_buildMatchQuery`'s real behavior verbatim: multi-token, no operators → tokens OR-joined
   (`lib/vault.js:564-570`). Real `searchNotes()` returns the top `limit` (default 10) rows
   by `bm25`/`rank`, so every comparison below uses `ORDER BY rank LIMIT 10` on both indexes
   — a raw total-match-count diff would be meaningless since the app never surfaces past the
   ranked top-N.
4. Diffed the two top-10 path sets per query, then manually read a sample of the notes that
   differed (via `snippet()` and raw `body`/`routing`) to judge relevance.
5. Ran one additional targeted check on a term family (`route`/`routing`/`router`/`routes`)
   that looked like a plausible bad-collision candidate given this codebase's own `routing`
   schema column, to see whether stemming was collapsing genuinely distinct technical senses.

Throwaway DB location: `<scratchpad>/calib/throwaway.db` (deleted with the rest of scratchpad
at session end; never touched the live path except via read-only `SELECT`/`.backup`).

## 2. Corpus size

**1,921 real notes** indexed on both sides (`type` breakdown: 1,484 synthesis, 388 session,
34 lesson, 6 reminder, 6 project, 3 untyped). Average body length 651 chars. Note: a live
`SELECT count(*)` against the production DB before and after this session showed 1921 → 1922
— an unrelated concurrent write by the live advisor process during this session (this worker
issued only `SELECT` statements against the live path, twice; `SELECT` cannot mutate rows).

## 3. Query table (top-10, BM25-ranked — matches real `searchNotes()` output shape)

| # | Query (OR-joined per `_buildMatchQuery`) | Full-match count cur/porter | Top-10 overlap | Gained (porter-only) | Dropped (current-only) |
|---|---|---|---|---|---|
| Q1 | worker OR verification OR blocked | 431 / 530 | 5 | 5 | 5 |
| Q2 | spawn OR coordination OR team | 143 / 229 | 6 | 4 | 4 |
| Q3 | vault OR schema OR migration | 208 / 219 | 8 | 2 | 2 |
| Q4 | worker OR dependency OR install | 403 / 447 | 7 | 3 | 3 |
| Q5 | deploy OR rollback OR commit | 137 / 365 | 8 | 2 | 2 |
| Q6 | cache OR invalidate OR index | 97 / 123 | 5 | 5 | 5 |
| Q7 | evaluate OR scoring OR worker | 360 / 425 | 3 | 7 | 7 |
| Q8 | token OR cost OR optimize | 136 / 173 | 4 | 6 | 6 |
| Q9 | config OR wiring OR hook | 204 / 293 | 5 | 5 | 5 |
| Q10 | delete OR cleanup OR regression | 90 / 142 | 5 | 5 | 5 |
| **Total** | | | | **44 gained / 44 dropped** (44% of all top-10 slots churned) |

Full-match counts also show stemming inflates the raw candidate pool 1.0x–2.7x per query
(e.g. Q5's `commit` pulls in `commitment`/`committed`/`commits`, `deploy` pulls in
`deployment`/`deployed`) — but that pool is never shown to the user; only the churn in the
top-10 column matters for the actual UX.

### Per-hit relevance judgement (sample of differing hits, read in full)

| Note | Query | Direction | Judged relevant? | Why |
|---|---|---|---|---|
| `lessons/manual-20260706-audit-deadcode-verify-before-delete-advisor-1.md` | Q10 | gained | **Yes — genuine morphology win** | routing tag says `deletion`/`verification`; query said `delete`; only porter's stem (`delet`) bridges them. Exactly the marker's own example pattern, on a highly on-topic lesson. |
| `lessons/manual-20260609-code-reviewer-context-optimizer-advisor-1.md` | Q8 | gained | **Yes — genuine morphology win** | routing says `optimizer optimization`; query said `optimize`. On-topic lesson about context/token optimization that unicode61 misses outright. |
| `projects/advisor-token-optimization-claim-verification.md` | Q8 | gained | **Yes — genuine morphology win** | Title-level match on token-optimization claim verification; surfaced only via the `optim*` stem family. |
| `lessons/manual-20260505-vnx-hooks-advisor-1.md` | Q1 | gained | **No new match — reranking artifact** | This note already contains the literal word `verification` (`article-verification`, `source-verification`), so unicode61 *can* match it exactly too. It only newly cracks the top-10 under porter because stemming changes corpus-wide term-frequency/IDF statistics, re-sorting bm25 ranks even for exact-term hits. This shows stemming has a **ranking side effect on every query**, not just morphologically-relevant ones. |
| `lessons/manual-20260625-advisor-token-optimization-advisor-1.md` | Q6 | dropped | Borderline | Only tangentially on-topic for "cache invalidate index" (mentions `cache-read-cost` tag, not indexing/invalidation). Its drop from top-10 isn't a clear relevance loss, but it does show a lesson-type note can get bumped by reranking noise. |
| `synthesis/1780063133-dcbc37-3.md`, `synthesis/1782740946-08ccfd-3.md`, `synthesis/1781533552-5146a6-3.md` | Q7 | gained/dropped | Inconclusive | Visible snippet doesn't clearly show why either index ranked them where it did; likely reranking noise from the generic, high-frequency `worker` token rather than a stemming-driven match. |

**Targeted collision check — `route`/`routing`/`router`/`routes`:** this is the closest thing
in the corpus to the marker's own worry ("cross-form recall... collapses distinctions"),
since `routing` is also this codebase's own FTS/schema column name, distinct from ordinary
"web routing" usage. Literal `routing` matches 22 notes under unicode61; the `rout` stem
matches 63 under porter (2.9x). I read the two notes porter uniquely pulled in for a bare
`route` query that neither `route` nor `routing`/`router`/`routes` matched literally:
both use the verb "routed" in the ordinary sense ("confirmation **routed** to Phase...",
"2 real claude sessions **routed** through it") — legitimately the same concept family, not
a harmful collision. **Hypothesis of a bad collision on this term was not substantiated** —
noted per the instruction not to prime the conclusion.

## 4. Measured recall gain and precision loss

- **Recall gain (measured):** in the 8-note sample manually read in full, **3 of 8** were
  clear, on-topic recall wins attributable specifically to morphological stemming (a query
  keyword's exact form never appears in the note, but a same-family form does). Scaled
  loosely across the 44 total "gained" top-10 slots, this suggests on the order of a third to
  a half are genuine wins, not all 44 — the rest are reranking noise (see next point). No
  case of stemming inventing a match with zero shared root was found.
- **Precision loss (measured):** **no case of a topically wrong note being pulled into the
  top-10** was found in the sample, and the targeted `route`-family collision check came back
  clean. The measured precision cost is instead **indirect**: stemming shifts corpus-wide
  term statistics enough to reorder bm25 ranks for notes that *already* matched exactly
  (the `vnx-hooks` case), and this reranking pushed at least one topically-adjacent lesson
  (`advisor-token-optimization-advisor-1.md`) out of a top-10 window for a related query. Across
  all 10 queries, **44 of 440 top-10 slots (10%) churned in each direction** — i.e. under
  porter, roughly 1 in 10 results a user would actually see changes, for reasons that are
  frequently statistical rather than semantic.
- **A one-sided "stemming only helps" story is not supported.** The real effect is: a modest,
  concretely-demonstrated recall win on genuine word-form mismatches, bought at the cost of
  a non-trivial amount of ranking churn/instability across *all* queries (including ones with
  no morphology issue at all), because porter changes the index's term-frequency statistics
  globally, not just for the queries that need it.

## 5. Recommendation

**Do not enable porter stemming as a wholesale tokenizer replacement on `notes_fts` right
now.** The measured recall gain is real but modest (a handful of genuinely-relevant hits per
query, not a step change), it is not free (10% top-10 churn per query from IDF-driven
reranking alone, affecting queries that have no morphology problem), and the switch is a
destructive, data-adjacent migration (see §6) on a store that has already suffered one
mass-deletion incident — the cost/benefit does not currently justify the risk.

If cross-form recall becomes a recurring, *documented* pain point (e.g. workers repeatedly
missing lessons at Step 5 due to a word-form mismatch, tracked over real sessions), the
lower-risk path is **not** to replace `notes_fts`'s tokenizer, but to add the porter-stemmed
table built in this experiment as a **secondary, read-only fallback index**, queried only when
the primary unicode61 search returns fewer than some small threshold of hits (e.g. < 3). That
captures the demonstrated recall benefit for the genuinely-starved queries without touching
the primary ranking path (so the 10% reranking-noise cost measured above never applies to the
common case), and it requires no destructive migration — it's an additive `CREATE VIRTUAL
TABLE` + backfill, droppable independently at any time.

## 6. If enabling anyway — migration steps and risks

Not recommended per §5, but for completeness:

1. `sqlite3 vault.db ".backup vault.db.pre-porter-$(date +%Y%m%dT%H%M%S)"` — full backup
   before touching anything (this store has no other recent full backup discipline visible;
   the existing `.backup-*` files in `.cache/` are stale, from 2026-05-21).
2. Changing `tokenize=` on an existing FTS5 table is **not** an `ALTER` — it requires
   `DROP TABLE notes_fts` followed by re-`CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='porter unicode61')`
   and a full reindex (`INSERT INTO notes_fts(rowid, path, body, routing) SELECT rowid, path, body, routing FROM notes`).
   There is no in-place upgrade path.
3. **Risk:** the DROP is irreversible without the backup from step 1. This is a
   data-adjacent migration on the same store that lost 286 notes to one careless CLI
   invocation — treat the DROP/reindex as a single transaction, verify row counts match
   before and after (`SELECT count(*) FROM notes` vs `SELECT count(*) FROM notes_fts`), and
   do not delete the pre-migration backup until a full search smoke-test against the new
   index passes.
4. The three triggers (`notes_ai`/`notes_ad`/`notes_au`) reference `notes_fts` by name and
   do not need to change, but must be verified to still fire correctly against the
   recreated table (same name, same `content_rowid` contract) before trusting live writes.
5. `_buildMatchQuery`'s OR-join behavior and `_escapeQuery`'s hyphen-phrase-quoting are
   tokenizer-agnostic and need no code change; only the debt-marker comment at
   `lib/vault.js:562` and its trigger condition would need updating (out of scope for this
   measurement — the advisor decides).
