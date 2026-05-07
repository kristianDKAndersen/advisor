'use strict';

const fs = require('fs');
const path = require('path');

const ADVISOR_ROOT = path.resolve(__dirname, '..');

function parseFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    if (lines[0] !== '---') return {};

    const endIdx = lines.indexOf('---', 1);
    if (endIdx === -1) return {};

    const yamlLines = lines.slice(1, endIdx);
    const result = {};
    let i = 0;

    while (i < yamlLines.length) {
      const line = yamlLines[i];

      if (line === '' || line.trim() === '') {
        i++;
        continue;
      }

      // key: (no value) — array field
      const arrayMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/);
      if (arrayMatch) {
        const key = arrayMatch[1];
        const items = [];
        i++;
        while (i < yamlLines.length && /^\s+-\s/.test(yamlLines[i])) {
          const itemMatch = yamlLines[i].match(/^\s+-\s+(.+)$/);
          if (itemMatch) items.push(itemMatch[1].trim());
          i++;
        }
        result[key] = items;
        continue;
      }

      // key: value — string field
      const strMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s+(.+)$/);
      if (strMatch) {
        result[strMatch[1]] = strMatch[2].trim();
        i++;
        continue;
      }

      // anything else is a parse error
      return {};
    }

    return result;
  } catch (_) {
    return {};
  }
}

function listAgentsWithMeta() {
  const agentsDir = path.join(ADVISOR_ROOT, 'agents');
  let entries;
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  return entries
    .filter(e => e.isDirectory())
    .map(e => {
      const claudeMd = path.join(agentsDir, e.name, 'CLAUDE.md');
      const frontmatter = parseFrontmatter(claudeMd);
      return { name: e.name, ...frontmatter };
    });
}

module.exports = { parseFrontmatter, listAgentsWithMeta };
