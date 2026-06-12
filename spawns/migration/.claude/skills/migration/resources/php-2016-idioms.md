# PHP-2016 Source-Pattern Catalog

A **target-agnostic** catalog of legacy PHP source patterns typical of codebases written or last modernized around 2016 (PHP 5.x era, pre-strict-types, often pre-Composer). Use during Steps 3-6 of the migration skill when the SOURCE repo is PHP.

**Target-agnostic by design:** this file describes what to detect in the OLD code and what intent each pattern encodes. It does NOT assume the migration target. Each pattern lists multiple target-mapping examples (Rust, Go, Python, TypeScript, modern PHP 8.x) — pick the one matching the arch_def's target language, or derive an equivalent from the encoded intent. The general per-language idioms live in [idiom-taxonomy.md](idiom-taxonomy.md); this catalog covers the PHP-specific SOURCE side.

## Contents

- Detection sweep (run first)
- P1: mysql_* / unparameterized queries
- P2: Untyped code (no scalar hints, no property types)
- P3: Superglobal access scattered through business logic
- P4: register_globals-era patterns (extract, variable variables)
- P5: Mixed HTML + logic (page scripts, echo-driven rendering)
- P6: Global state and require-based wiring
- P7: Arrays-as-everything (associative arrays as records)
- P8: Error suppression and die()-based error handling
- P9: Weak crypto and password handling (md5/sha1, mcrypt)
- P10: include/require pseudo-modularity (no autoloading)
- P11: $_SESSION-coupled business logic
- P12: String-built SQL/HTML (injection and XSS surface)
- Priority guidance for slicing

## Detection sweep (run first)

One grep pass flags most patterns; record counts per file for hotspot correlation with Step 4 churn data:

```bash
grep -rEn 'mysql_query|mysql_connect|mysql_fetch' --include='*.php' "$SOURCE_REPO" | head -30
grep -rEn '\$_(GET|POST|REQUEST|COOKIE|SERVER)\[' --include='*.php' "$SOURCE_REPO" | wc -l
grep -rEn 'extract\s*\(\s*\$_(REQUEST|GET|POST)' --include='*.php' "$SOURCE_REPO" | head -10
grep -rEn '^\s*global\s+\$' --include='*.php' "$SOURCE_REPO" | head -30
grep -rEn 'md5\s*\(.*(pass|pwd)|mcrypt_' --include='*.php' "$SOURCE_REPO" | head -10
grep -rEn '@(mysql_|file_get_contents|fopen)|die\s*\(|exit\s*\(' --include='*.php' "$SOURCE_REPO" | wc -l
grep -rLn 'declare\(strict_types' --include='*.php' "$SOURCE_REPO" | wc -l   # files WITHOUT strict types
grep -rEn '\?>\s*<(html|div|table|td|tr)' --include='*.php' "$SOURCE_REPO" | head -20   # logic/markup interleave
```

---

## P1: mysql_* / unparameterized queries

**Source form:** `mysql_connect`, `mysql_query("SELECT ... WHERE id=$id")`, `mysql_fetch_assoc` loops; the `mysql_*` extension was deprecated in 5.5 and removed in PHP 7, so its presence firmly dates the code. Variants: `mysqli_query` with interpolated strings.

**Encoded intent:** a data-access layer that never got abstracted — each call site IS the repository layer. Query strings encode the real schema and the real relationships; harvest them as primary schema evidence.

**Detection:** `mysql_[a-z_]+\(` ; string interpolation inside query literals (`"...$var..."` or `'...' . $var . '...'`).

**Target mappings (modern parameterized data-access):**
- Rust: `sqlx::query!("SELECT ... WHERE id = $1", id)` (compile-time checked) or diesel.
- Go: `database/sql` prepared statements / `sqlc`-generated typed queries.
- Python: SQLAlchemy Core/ORM with bound parameters; never f-string SQL.
- TypeScript: Prisma/Drizzle/knex with placeholder bindings.
- Modern PHP: PDO prepared statements or Doctrine DBAL/ORM.

**Idiomatic-note seed:** "Replace interpolated mysql_query call sites with <target's parameterized facility>; centralize into a repository per aggregate."

## P2: Untyped code (no scalar hints, no property types)

**Source form:** `function calc($a, $b)` with no parameter or return types; class properties declared bare (`var $name;` / `public $items;`); `declare(strict_types=1)` absent (scalar hints arrived PHP 7.0, property types 7.4 — 2016 code predates both in practice).

**Encoded intent:** types exist only in the developers' heads and in phpDoc comments. Mine `@param`/`@return` docblocks and call-site usage to RECOVER the implicit types; they become explicit in any modern target.

**Detection:** `function\s+\w+\([^):]*\)\s*\{` (params without `:` type); `@param` docblocks richer than signatures.

**Target mappings (typed signatures/properties):**
- Rust/Go: types are mandatory; the recovery work happens at planning time — record recovered types in the concept map.
- Python: full type annotations + `mypy`/`pyright` strict; `@dataclass` for record shapes.
- TypeScript: explicit parameter/return types, `strict: true`; no `any` escapes.
- Modern PHP: `declare(strict_types=1)`, typed properties, enums (8.1), readonly properties (8.1).

## P3: Superglobal access scattered through business logic

**Source form:** `$_GET['id']`, `$_POST['email']`, `$_REQUEST[...]`, `$_SERVER[...]` read deep inside functions/classes far from any entry point; often combined with inline casting (`(int)$_GET['id']`) or none at all.

**Encoded intent:** the request boundary. Every superglobal read marks a spot where external input enters domain logic — these are the seams to cut when extracting a request/DTO abstraction.

**Detection:** `\$_(GET|POST|REQUEST|COOKIE|SERVER)\[` outside the top-level entry scripts.

**Target mappings (request abstraction at the boundary):**
- Rust: axum/actix extractors (`Query<T>`, `Json<T>`) deserializing into typed structs.
- Go: `http.Request` parsing in handlers only; typed request structs passed inward.
- Python: FastAPI/pydantic models; Flask `request` confined to view functions.
- TypeScript: framework request objects validated with `zod` at the route layer only.
- Modern PHP: PSR-7 `ServerRequestInterface` + form-request/DTO mapping (Laravel FormRequest, Symfony Request).

**Slicing note:** superglobal density per file is a strong subsystem-boundary signal — pages clustering on the same superglobals usually form one behavior slice.

## P4: register_globals-era patterns (extract, variable variables)

**Source form:** `extract($_REQUEST)`, `$$varname`, code that assumes request keys materialize as locals (a habit surviving from register_globals, removed in PHP 5.4 but idiomatically alive in 2016 legacy code); hidden-field trust (`$_POST['is_admin']`).

**Encoded intent:** none worth preserving — this is pure hazard. The pattern's only value is that the extracted variable NAMES enumerate the expected request schema.

**Detection:** `extract\s*\(` , `\$\$` , writes to `$GLOBALS\[`.

**Target mappings:** there is no "equivalent" — in every target this becomes explicit, validated input binding (see P3 mappings). Flag each occurrence as a security-relevant behavior to be contract-tested, not reproduced: the literal Commit 1 must preserve observable behavior, but the equivalence spec should pin only the documented inputs, never the implicit "any request key becomes a variable" behavior.

## P5: Mixed HTML + logic (page scripts, echo-driven rendering)

**Source form:** `.php` files alternating `<?php ... ?>` and raw HTML; `echo "<tr><td>$row[name]</td></tr>"` inside query loops; business decisions (`if ($user['paid'])`) interleaved with markup; one file per page acting as controller+view+model.

**Encoded intent:** each page script encodes a use case (input → query → decision → presentation) as a single linear narrative. Recover the THREE layers from the interleave: the data it fetches (model), the branching (logic), the output shape (view contract).

**Detection:** `\?>` followed by markup in files that also define functions/queries; `echo` with embedded HTML tags.

**Target mappings (logic/presentation separation):**
- Rust: handler returns typed view-model; askama/maud templates or a JSON API + separate frontend.
- Go: `html/template` with a typed data struct per view; handlers never fmt.Sprintf HTML.
- Python: Jinja2 templates with context dicts built by view functions; or DRF serializers.
- TypeScript: server components/JSX or API endpoints returning typed DTOs.
- Modern PHP: Twig/Blade templates; controllers return response objects.

**Slicing note:** each legacy page script usually becomes TWO concept-map rows (a use-case/service row and a view/endpoint row) with cardinality 1:N.

## P6: Global state and require-based wiring

**Source form:** `global $db, $config, $current_user;` at the top of functions; a `config.php`/`init.php` that opens connections and populates globals as an import side effect; `$GLOBALS['...']` access.

**Encoded intent:** the dependency graph. The set of globals a function pulls in IS its constructor signature in the target architecture.

**Detection:** `^\s*global\s+\$` ; assignments at top level of included files.

**Target mappings (explicit dependency injection):**
- Rust: dependencies as struct fields / function parameters; `OnceLock` only for true process-wide config.
- Go: config struct + dependencies passed explicitly; `sync.Once` for lazy init; no package-level mutable vars.
- Python: constructor injection; `pydantic.BaseSettings` for env config; no module-level mutation.
- TypeScript: constructor injection or DI container; readonly config object.
- Modern PHP: PSR-11 container with constructor injection (Symfony DI, Laravel container).

**Graph context required:** count distinct accessor files per global (graphify or grep). A one-file global can become a local; a twenty-file global needs a first-wave "extract shared service" slice that many later slices depend on.

## P7: Arrays-as-everything (associative arrays as records)

**Source form:** functions passing `$user`, `$order` as associative arrays; shape discoverable only by reading every `$user['...']` access; `list()` destructuring; arrays doubling as sets, tuples, and option-bags (`$opts['verbose'] ?? false` or its 2016 form `isset($opts['verbose']) ? ... : ...`).

**Encoded intent:** the domain model. Reconstruct each array's de-facto shape by unioning the keys accessed across the codebase — that union is the entity definition for the concept map.

**Detection:** repeated `\$\w+\['` chains on the same variable; functions returning `array(` / `[` literals with string keys.

**Target mappings (typed records/DTOs):**
- Rust: `struct` per entity, `Option<T>` for the maybe-keys, `serde` derives.
- Go: struct per entity with explicit zero-value semantics for optional fields.
- Python: `@dataclass` or pydantic models; `TypedDict` for transitional shapes.
- TypeScript: `interface` per entity; discriminated unions where one array served several shapes.
- Modern PHP: readonly classes / typed DTOs; enums replacing magic-string keys.

**Slicing note:** these reconstructed entities are exactly the "foundational data models first" slices of Step 6 ordering rule 1.

## P8: Error suppression and die()-based error handling

**Source form:** `@mysql_query(...)`, `or die("DB error")`, `die(mysql_error())`, `exit;` mid-logic, `trigger_error`, empty `catch` blocks (where exceptions exist at all); errors leaking raw to the browser.

**Encoded intent:** every `die()` marks a failure path the original author considered fatal; every `@` marks one they considered ignorable. That classification (fatal vs ignorable) is real behavioral information — preserve the CLASSIFICATION, not the mechanism.

**Detection:** `@[a-z_]+\(` , `or die` , `die\(` , `exit\(` , `catch\s*\([^)]*\)\s*\{\s*\}`.

**Target mappings (structured error handling):**
- Rust: `Result<T, E>` with typed error enums; `?` propagation; no `unwrap()` in library paths.
- Go: `(value, error)` returns wrapped with `fmt.Errorf("context: %w", err)`.
- Python: specific exception types, `raise ... from ...` chaining; top-level handler renders the response.
- TypeScript: typed Error subclasses or Result types; central error middleware.
- Modern PHP: exceptions + a single top-level handler; never `die()` in domain code.

## P9: Weak crypto and password handling (md5/sha1, mcrypt)

**Source form:** `md5($password)` (often unsalted) stored in a `users.password` column; `sha1`; `mcrypt_encrypt` (mcrypt was deprecated 7.1, removed 7.2); home-rolled tokens via `uniqid()`/`rand()`.

**Encoded intent:** authentication and secrecy requirements. The WHAT (verify a password, encrypt a payload, generate an unguessable token) migrates; the HOW must not.

**Detection:** `md5\(|sha1\(|mcrypt_|uniqid\(|\brand\(` near auth/token/session code.

**Target mappings (modern primitives — every target):** password hashing via the platform's adaptive hash (Rust `argon2` crate; Go `golang.org/x/crypto/bcrypt`; Python `argon2-cffi`/passlib; Node `argon2`/`bcrypt`; modern PHP `password_hash()`), CSPRNG token generation, vetted AEAD libraries for encryption.

**Plan obligation:** legacy-hash coexistence is a BEHAVIOR: the slice plan must include a rehash-on-login or migration strategy slice, and the equivalence spec must cover "existing md5 users can still log in" if epics require account continuity. Surface this to the user — it is a policy decision, not a silent upgrade.

## P10: include/require pseudo-modularity (no autoloading)

**Source form:** `require_once 'functions.php'` / `include '../lib/db.php'` chains; path math with `dirname(__FILE__)`; load-order sensitivity; no Composer (`composer.json` absent or vestigial).

**Encoded intent:** the include graph IS the module graph. Build it explicitly — it is the primary input to graphify fallback and wave ordering when no package manifest exists:

```bash
grep -rEn '(require|include)(_once)?\s*[\(]?\s*["\x27]' --include='*.php' "$SOURCE_REPO" \
  | sed -E 's/:[0-9]+:.*["\x27]([^"\x27]+)["\x27].*/ -> \1/' | sort -u > "$WORKSPACE/php_include_graph.txt"
```

**Target mappings (real module systems):** Rust crates/modules; Go packages; Python packages with explicit imports; TypeScript ES modules; modern PHP PSR-4 namespaces + Composer autoload. In all targets, each legacy "library file" (functions.php, helpers.php) usually splits 1:N into cohesive modules — record the split in the concept map.

## P11: $_SESSION-coupled business logic

**Source form:** `session_start()` at the top of every page; `$_SESSION['cart']`, `$_SESSION['user_id']` read/written deep in domain functions; session as a de-facto database for multi-step flows.

**Encoded intent:** two distinct things conflated — (a) authentication state, (b) multi-step workflow state (carts, wizards). Separate them in the concept map; they map to different target components.

**Detection:** `\$_SESSION\[` outside auth bootstrap; `session_` function calls.

**Target mappings:**
- Auth state: token/cookie-based session middleware (any target's framework facility); identity passed as a typed principal/context parameter, never read ambiently.
- Workflow state: explicit store (DB table, Redis) behind a repository interface; state-machine types where steps are enumerable.

## P12: String-built SQL/HTML (injection and XSS surface)

**Source form:** `"SELECT * FROM users WHERE name='" . $name . "'"`; `echo $userInput;` without `htmlspecialchars`; cross-cutting with P1/P5 but worth tracking separately because every occurrence is a security finding AND an equivalence-test hazard (the legacy behavior may be exploitable; do not golden-master the exploit).

**Detection:** query keywords inside double-quoted interpolated strings; `echo`/`print` of request-derived variables without an escaping wrapper.

**Target mappings:** parameterized queries (P1 mappings) + auto-escaping template engines (P5 mappings) + output encoding at the boundary. **Equivalence-spec rule:** pin the legitimate behavior (the query's result set for valid inputs), never byte-for-byte output of unescaped markup — note the deliberate behavior change in the slice's `idiomatic_note` and flag it for the user.

---

## Priority guidance for slicing

| Priority | Patterns | Why |
|---|---|---|
| Critical | P1, P9, P12 | Security-sensitive; mappings need user-visible policy decisions (legacy hash coexistence, escaping changes) |
| High | P3, P5, P6 | Define the architectural seams (request boundary, layer split, dependency graph) that determine slice and wave structure |
| Medium | P2, P7, P10 | Type/shape recovery; feeds the foundational data-model slices |
| Contextual | P4, P8, P11 | Localized hazards; handle within whichever slice owns the file |

Cross-reference every pattern hit against Step 4 churn data: a HIGH-CHURN file dense in Critical patterns is the strongest candidate for a fine-grained slice with the most thorough equivalence spec.
