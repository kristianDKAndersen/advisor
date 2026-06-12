'use strict';
const path = require('path');

const CAP_CHARS = 16000;

function inferAffectedDirs(modifiedFiles, repoRoot) {
  const root = repoRoot.replace(/\/+$/, '');
  const dirSet = new Set();
  for (const f of modifiedFiles) {
    const normalized = f.replace(/^\.\//, '');
    const dirName = path.dirname(normalized);
    const parts = dirName === '.' ? [] : dirName.split('/');
    dirSet.add(root);
    for (let i = 0; i < parts.length; i++) {
      dirSet.add(root + '/' + parts.slice(0, i + 1).join('/'));
    }
  }
  return Array.from(dirSet);
}

function generateAgentsMdUpdate(dirPath, synthRecord, existingContent) {
  const sid = synthRecord.sid;
  const seq = synthRecord.seq;
  const ts = synthRecord.ts || new Date().toISOString();
  const established = synthRecord.established || '';

  const frontmatter =
    `---\nscope: "${dirPath}"\nlast_updated_by: "sid:${sid} seq:${seq}"\nlast_updated_ts: "${ts}"\n---\n`;

  const bodyPrefix = '\n';
  const bodyText = established + '\n';
  let out = frontmatter + bodyPrefix + bodyText;

  if (out.length > CAP_CHARS) {
    const available = CAP_CHARS - frontmatter.length - bodyPrefix.length - 1;
    out = frontmatter + bodyPrefix + established.slice(0, Math.max(0, available)) + '\n';
    if (out.length > CAP_CHARS) out = out.slice(0, CAP_CHARS);
  }

  return out;
}

module.exports = { inferAffectedDirs, generateAgentsMdUpdate };
