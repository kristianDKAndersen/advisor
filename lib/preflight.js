'use strict';

const { spawn } = require('child_process');

const FAIL_OPEN = { is_vague: false, gap_signals: [] };

const SYSTEM_PROMPT = [
  'You are a task-clarity classifier. Output ONLY a single line of raw JSON.',
  'No prose, no markdown fences, no explanation, no follow-up questions.',
  'Schema: {"is_vague": boolean, "gap_signals": string[]}.',
  'is_vague=true when the task lacks audience, scope, format, or concrete subject.',
  'gap_signals is a short list of missing dimensions, max 4 items, each one short word.',
  'Examples:',
  '"help" -> {"is_vague":true,"gap_signals":["scope","subject"]}',
  '"fix the failing test in tests/foo.test.js" -> {"is_vague":false,"gap_signals":[]}',
].join(' ');

/**
 * Spawn `claude --print` with Haiku to classify task clarity.
 * Uses the user's claude subscription auth (OAuth), not ANTHROPIC_API_KEY.
 *
 * Returns the model's raw text output, or throws on timeout / non-zero exit.
 */
function defaultClaudeRunner({ prompt, available, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const systemPrompt = available && available.length
      ? `${SYSTEM_PROMPT} Available agents: ${available.join(', ')}.`
      : SYSTEM_PROMPT;

    // Use --system-prompt (full replacement) and feed prompt via stdin to
    // avoid the --tools variadic swallowing the positional prompt arg.
    const args = [
      '--print',
      '--model', 'haiku',
      '--output-format', 'json',
      '--system-prompt', systemPrompt,
      '--disable-slash-commands',
      '--exclude-dynamic-system-prompt-sections',
    ];

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(prompt);
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error('preflight timeout'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      }
      try {
        const envelope = JSON.parse(stdout);
        const text = envelope.result || envelope.text || '';
        resolve(text);
      } catch (err) {
        reject(new Error(`failed to parse claude envelope: ${err.message}`));
      }
    });
  });
}

/**
 * Run a fast ambiguity check before summoning a full worker.
 *
 * @param {object} args
 * @param {string} args.prompt           User's raw task text.
 * @param {string[]} [args.available]    Hints (e.g., known agent names) for the classifier.
 * @param {number} [args.timeoutMs=4000] Hard timeout. Fail-open on timeout.
 * @param {object} [args.deps]           Injection point for tests: {claudeRunner}.
 * @returns {Promise<{is_vague: boolean, gap_signals: string[]}>}
 */
async function preflight({ prompt, available = [], timeoutMs = 4000, deps = {} } = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return { ...FAIL_OPEN };
  }

  const runner = (deps && deps.claudeRunner) || defaultClaudeRunner;

  try {
    const text = await runner({ prompt, available, timeoutMs });
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      is_vague: Boolean(parsed.is_vague),
      gap_signals: Array.isArray(parsed.gap_signals) ? parsed.gap_signals : [],
    };
  } catch {
    return { ...FAIL_OPEN };
  }
}

module.exports = { preflight };
