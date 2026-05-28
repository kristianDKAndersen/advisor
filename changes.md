# automation/mcp-sqlite-vault — Unit 2

## Decision: Install bytebase/dbhub

### Candidates Evaluated

#### 1. bytebase/dbhub — SELECTED

| Criterion | Result |
|-----------|--------|
| (a) Actively maintained (last commit within 6 months of 2026-05-28) | PASS — pushed 2026-04-21 |
| (b) Supports read-only flag or mode | PASS — `readonly = true` on `[[tools]]` in dbhub.toml |
| (c) Permissive license (MIT/Apache/BSD) | PASS — MIT |
| (d) >= 50 stars OR official MCP server list | PASS — 2847 stars |

**Install command:** `npx @bytebase/dbhub@latest`
**Read-only mode:** configured via `~/.advisor/vault/dbhub.toml` (the `--readonly` CLI flag was removed in a recent version; TOML config is the only supported path)

#### 2. hannesrudolph/sqlite-explorer-fastmcp-mcp-server — REJECTED

| Criterion | Result |
|-----------|--------|
| (a) Actively maintained | FAIL — last push 2025-07-18 (>6 months before cutoff 2025-11-28) |
| (b) Supports read-only | PASS — read-only by design |
| (c) Permissive license | FAIL — no license specified in repo |
| (d) Stars / official list | PASS — 105 stars |

**Rejected:** fails criteria (a) and (c).

#### 3. Fanom2813/mcp-sqlite-readonly — REJECTED

| Criterion | Result |
|-----------|--------|
| (a) Actively maintained | FAIL — last push 2025-10-05 (before 2025-11-28 cutoff) |
| (b) Supports read-only | PASS — read-only by design (security-hardened fork) |
| (c) Permissive license | PASS — MIT |
| (d) Stars / official list | FAIL — 0 stars, not on official list |

**Rejected:** fails criteria (a) and (d).

#### 4. Official mcp-server-sqlite (modelcontextprotocol) — REJECTED

| Criterion | Result |
|-----------|--------|
| (a) Actively maintained | FAIL — archived, last release April 2025 |
| (b) Supports read-only | Unknown (archived) |
| (c) Permissive license | PASS — MIT |
| (d) Stars / official list | PASS — was on official list |

**Rejected:** explicitly archived, no new releases expected.

### Files Written

- `.mcp.json` — updated with `sqlite` server entry (dbhub, stdio transport, `--config ~/.advisor/vault/dbhub.toml`)
- `~/.advisor/vault/dbhub.toml` — read-only sqlite config for vault.db

> **Note:** The auto-mode classifier in this worker session blocked `git commit` of `.mcp.json`
> (classified as self-modification of MCP tool surface). The file is written on disk and staged.
> To finalize the commit, run:
>
> ```bash
> cd .
> git add .mcp.json
> git commit --amend --no-edit
> ```

### Smoke Test Instructions

The MCP server cannot be exec'd from within a worker session. To manually verify after the branch lands:

1. Ensure `~/.advisor/vault/dbhub.toml` exists (written by this task — see content below).
2. Start the server in a terminal:
   ```bash
   npx @bytebase/dbhub@latest --transport stdio --config ~/.advisor/vault/dbhub.toml
   ```
3. In a separate session, send an MCP `tools/call` request for `execute_sql`:
   ```json
   {"method":"tools/call","params":{"name":"execute_sql","arguments":{"sql":"SELECT count(*) FROM notes","sourceId":"vault"}}}
   ```
   Expected response: `989` (row count verified via `sqlite3 ~/.advisor/vault/.cache/vault.db`).
4. Confirm write is rejected:
   ```json
   {"method":"tools/call","params":{"name":"execute_sql","arguments":{"sql":"DELETE FROM notes WHERE 1=0","sourceId":"vault"}}}
   ```
   Expected: error `Read-only mode is enabled`.

### dbhub.toml content (at ~/.advisor/vault/dbhub.toml)

```toml
[[sources]]
id = "vault"
dsn = "sqlite://${HOME}/.advisor/vault/.cache/vault.db"

[[tools]]
name = "execute_sql"
source = "vault"
readonly = true

[[tools]]
name = "search_objects"
source = "vault"
```

### Merge Note

Unit 1 (branch `automation/mcp-obsidian` or similar) also writes `.mcp.json`. Merging both branches to master will produce a merge conflict on `.mcp.json`. The user must manually resolve it by combining both `mcpServers` entries. Neither branch should be rebased onto the other — resolve at merge time.
