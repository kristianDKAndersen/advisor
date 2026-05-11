import { test, expect } from 'bun:test';
import { DISCOVERY_SCAFFOLDING } from '../lib/scaffolding.js';

test('DISCOVERY_SCAFFOLDING is a string', () => {
  expect(typeof DISCOVERY_SCAFFOLDING).toBe('string');
});

test('DISCOVERY_SCAFFOLDING includes the [DISCOVERY_SCAFFOLDING] marker', () => {
  expect(DISCOVERY_SCAFFOLDING).toContain('[DISCOVERY_SCAFFOLDING]');
});
