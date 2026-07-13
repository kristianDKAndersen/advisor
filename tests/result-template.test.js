import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE = join(import.meta.dir, '..', 'templates', 'RESULT.md');

describe('templates/RESULT.md contract', () => {
  test('contains the three required section headers', () => {
    const content = readFileSync(TEMPLATE, 'utf8');
    expect(content).toMatch(/^##\s+Completed/m);
    expect(content).toMatch(/^##\s+Verification/m);
    expect(content).toMatch(/^##\s+Remaining Work/m);
  });
});
