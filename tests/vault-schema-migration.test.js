// R1/R2 regression: transparent schema migration for pre-`routing` vaults, and
// error surfacing in searchNotes. These build synthetic OLD-schema vaults in
// tmpdirs and NEVER touch the real vault (~/.advisor/vault).
import { test, expect, beforeEach, afterEach } from "bun:test";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Database } = require("bun:sqlite");

// Import after env plumbing is available; vault reads ADVISOR_VAULT lazily.
const vault = require(path.join(__dirname, "..", "lib", "vault.js"));

const ORIG_VAULT = process.env.ADVISOR_VAULT;
const tmps = [];

afterEach(() => {
  if (ORIG_VAULT === undefined) delete process.env.ADVISOR_VAULT;
  else process.env.ADVISOR_VAULT = ORIG_VAULT;
});

// Build a vault dir whose .cache/vault.db carries the OLD two-column schema:
// `notes` has no `routing` column, `notes_fts` is fts5(path UNINDEXED, body),
// and the note's routing tokens (task_type + tags) live only in frontmatter,
// never in the body — so they are invisible to the old index.
function makeOldSchemaVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-old-"));
  tmps.push(dir);
  fs.mkdirSync(path.join(dir, "lessons"), { recursive: true });
  const md =
    "---\n" +
    "type: lesson\n" +
    "task_type: deployment\n" +
    "tags:\n  - kubernetes\n  - rollback\n" +
    "created_at: 2026-01-01T00:00:00Z\n" +
    "---\n" +
    "The widget frobnicator must be greased before the flange turns.\n";
  fs.writeFileSync(path.join(dir, "lessons", "l1.md"), md);

  const cache = path.join(dir, ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const d = new Database(path.join(cache, "vault.db"));
  d.exec("PRAGMA journal_mode=WAL");
  d.exec(
    "CREATE TABLE notes (path TEXT PRIMARY KEY, type TEXT, sid TEXT, seq INTEGER, agent TEXT, repo TEXT, created_at TEXT, material TEXT, next_action TEXT, established TEXT, gap TEXT, plan_ref TEXT, body TEXT);"
  );
  d.exec(
    "CREATE VIRTUAL TABLE notes_fts USING fts5(path UNINDEXED, body, content='notes', content_rowid='rowid');"
  );
  d.exec("CREATE TABLE links (source TEXT, target TEXT, PRIMARY KEY(source,target));");
  d.exec(
    "CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, path, body) VALUES (new.rowid, new.path, new.body); END;"
  );
  d.prepare(
    "INSERT INTO notes (path, type, body, created_at) VALUES (?,?,?,?)"
  ).run(
    "lessons/l1.md",
    "lesson",
    "The widget frobnicator must be greased before the flange turns.",
    "2026-01-01T00:00:00Z"
  );
  d.close();
  return dir;
}

function ftsSql(dbFile) {
  const d = new Database(dbFile);
  const row = d
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'")
    .get();
  d.close();
  return (row && row.sql) || "";
}

function notesCols(dbFile) {
  const d = new Database(dbFile);
  const cols = d.prepare("PRAGMA table_info(notes)").all().map((r) => r.name);
  d.close();
  return cols;
}

test("precondition: synthetic old vault has 2-column FTS and no routing column", () => {
  const dir = makeOldSchemaVault();
  const dbFile = path.join(dir, ".cache", "vault.db");
  expect(ftsSql(dbFile)).not.toContain("routing");
  expect(notesCols(dbFile)).not.toContain("routing");
});

test("R1: routing tokens invisible before migration are recalled after transparent upgrade", () => {
  const dir = makeOldSchemaVault();
  process.env.ADVISOR_VAULT = dir;

  // A query built only from the note's routing tokens (task_type + tags), none
  // of which appear in the body. On the old schema this recalls nothing; the
  // transparent migration must rebuild the index so it recalls l1.md.
  const res = vault.searchNotes("deployment kubernetes rollback");
  expect(res.length).toBeGreaterThanOrEqual(1);
  expect(res.some((r) => r.path === "lessons/l1.md")).toBe(true);

  // The on-disk schema was actually upgraded, not just queried around.
  const dbFile = path.join(dir, ".cache", "vault.db");
  expect(ftsSql(dbFile)).toContain("routing");
  expect(notesCols(dbFile)).toContain("routing");
});

test("R1: migration is idempotent and safe to run repeatedly", () => {
  const dir = makeOldSchemaVault();
  process.env.ADVISOR_VAULT = dir;

  const first = vault.searchNotes("deployment kubernetes rollback");
  expect(first.some((r) => r.path === "lessons/l1.md")).toBe(true);

  // Force the module to drop its handle and re-open against the now-current
  // vault.db (toggling the path resets the per-process migration guard). A
  // current-schema vault must report no drift and NOT rebuild again.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "vault-other-"));
  tmps.push(other);
  process.env.ADVISOR_VAULT = other;
  vault.searchNotes("noop"); // opens a different db, resets guard
  process.env.ADVISOR_VAULT = dir;

  const second = vault.searchNotes("deployment kubernetes rollback");
  expect(second.some((r) => r.path === "lessons/l1.md")).toBe(true);
  expect(second.length).toBe(first.length);

  // .md source of truth intact.
  expect(fs.existsSync(path.join(dir, "lessons", "l1.md"))).toBe(true);
});

test("R2: a genuine SQL/schema failure is surfaced via console.error, not silently swallowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-corrupt-"));
  tmps.push(dir);
  const cache = path.join(dir, ".cache");
  fs.mkdirSync(cache, { recursive: true });
  // A non-SQLite file: opening/execing it throws "file is not a database".
  fs.writeFileSync(path.join(cache, "vault.db"), "this is definitely not a sqlite database\n");
  process.env.ADVISOR_VAULT = dir;

  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.map(String).join(" "));
  let res;
  try {
    res = vault.searchNotes("anything at all");
  } finally {
    console.error = orig;
  }

  // Fail-open contract preserved.
  expect(res).toEqual([]);
  // But the failure was surfaced, not hidden.
  expect(errs.some((e) => /searchNotes failed/.test(e))).toBe(true);
});
