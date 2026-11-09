// Prints the herdr gate env as JSON. Run by setup-herdr-env.test.js as a child
// process. The name matches none of bun test's patterns (*.test.*, *_test.*,
// *.spec.*), and nothing runs on import, so it is never collected as a test.
const KEYS = ['ADVISOR_HERDR', 'HERDR_ENV', 'ADVISOR_NO_REAPER'];

if (require.main === module) {
  const out = {};
  for (const k of KEYS) out[k] = process.env[k] === undefined ? null : process.env[k];
  process.stdout.write(JSON.stringify(out) + '\n');
}

module.exports = { KEYS };
