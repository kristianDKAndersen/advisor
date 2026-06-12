'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

// Parse YAML frontmatter fields (simple key: value, optionally quoted).
// Returns null if no valid frontmatter block found.
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return null;

  const closeIdx = lines.slice(1).findIndex(l => l.trim() === '---');
  if (closeIdx === -1) return null;

  const fmLines = lines.slice(1, closeIdx + 1);
  const fields = {};
  for (const line of fmLines) {
    const m = line.match(/^([\w_]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fields[m[1]] = val;
  }
  return fields;
}

// Validate content against LR-1..LR-6. Returns array of violation strings.
function lint(content, filename) {
  const lines = content.split('\n');

  // LR-1
  if (lines[0].trim() !== '---') {
    return [`${filename}: missing YAML frontmatter block — file must begin with ---`];
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    return [`${filename}: missing YAML frontmatter block — file must begin with ---`];
  }

  const violations = [];

  // LR-2
  if (!fm.scope || !fm.scope.trim()) {
    violations.push(`${filename}: missing required frontmatter field: scope`);
  }

  // LR-3 / LR-5
  if (!fm.last_updated_by || !fm.last_updated_by.trim()) {
    violations.push(`${filename}: missing required frontmatter field: last_updated_by`);
  } else if (!/^sid:\S+ seq:\d+$/.test(fm.last_updated_by)) {
    violations.push(
      `${filename}: malformed last_updated_by — expected format: sid:<sid> seq:<seq>`
    );
  }

  // LR-4 / LR-6
  if (!fm.last_updated_ts || !fm.last_updated_ts.trim()) {
    violations.push(`${filename}: missing required frontmatter field: last_updated_ts`);
  } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(fm.last_updated_ts)) {
    violations.push(
      `${filename}: malformed last_updated_ts — expected ISO 8601 UTC format: YYYY-MM-DDTHH:MM:SSZ`
    );
  }

  return violations;
}

// PreToolUse[Bash] commit-gate mode.
// Reads JSON tool input from stdin, exits 0 unless this is a git commit with
// staged AGENTS.md files that fail the lint rules.
function commitGate() {
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    input = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const cmd = (input.tool_input && input.tool_input.command) || '';

  // Only act on git commit commands
  if (!/\bgit\s+commit\b/.test(cmd)) {
    process.exit(0);
  }

  const result = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' });
  if (result.status !== 0) process.exit(0);

  const stagedAgentsMd = result.stdout
    .split('\n')
    .map(f => f.trim())
    .filter(f => f === 'AGENTS.md' || f.endsWith('/AGENTS.md'));

  if (stagedAgentsMd.length === 0) process.exit(0);

  const allViolations = [];
  for (const file of stagedAgentsMd) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    allViolations.push(...lint(content, file));
  }

  if (allViolations.length > 0) {
    process.stderr.write(allViolations.join('\n') + '\n');
    process.exit(2);
  }

  process.exit(0);
}

// Expose lint and parseFrontmatter for testing
module.exports = { lint, parseFrontmatter };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === '--commit-gate') {
    commitGate();
  } else if (args[0] === '--file') {
    const file = args[1];
    if (!file) {
      process.stderr.write('Usage: agents-md-lint.js --file <path>\n');
      process.exit(1);
    }
    const content = fs.readFileSync(file, 'utf8');
    const violations = lint(content, file);
    if (violations.length > 0) {
      process.stderr.write(violations.join('\n') + '\n');
      process.exit(1);
    }
    process.exit(0);
  } else {
    // Default: read from stdin
    const content = fs.readFileSync(0, 'utf8');
    const filename = args[0] || '<stdin>';
    const violations = lint(content, filename);
    if (violations.length > 0) {
      process.stderr.write(violations.join('\n') + '\n');
      process.exit(1);
    }
    process.exit(0);
  }
}
