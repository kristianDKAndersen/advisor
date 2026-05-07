import { createHash } from 'crypto';

const counts = new Map();

function sortedJSON(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return JSON.stringify(val);
  }
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedJSON(val[k])).join(',') + '}';
}

export function canonicalHash(toolName, args) {
  const payload = JSON.stringify(toolName) + ':' + sortedJSON(args);
  return createHash('sha256').update(payload).digest('hex');
}

export function checkDuplicate(toolName, args) {
  const sig = canonicalHash(toolName, args);
  const count = (counts.get(sig) ?? 0) + 1;
  counts.set(sig, count);
  const duplicate = count >= 3;
  return { duplicate, count, halt: duplicate };
}

export function resetState() {
  counts.clear();
}
