import { describe, test } from 'bun:test';

// tests/close-tab.test.sh drives real macOS Terminal.app windows via
// osascript — it opens windows, focuses tabs, and waits on real TTYs under
// a fixed /tmp/close-tab-test dir. That's a live side effect on whatever
// Terminal session is running, not a hermetic unit test, and it cannot be
// made hermetic without replacing Terminal.app with a mock. It stays
// manual: run it directly with `bash tests/close-tab.test.sh`.
describe('close-tab.test.sh', () => {
  test.skip('manual only — drives real Terminal.app windows, not hermetic. Run: bash tests/close-tab.test.sh', () => {});
});
