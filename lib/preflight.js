'use strict';

const FAIL_OPEN = { is_vague: false, gap_signals: [] };

/**
 * Run a fast ambiguity check before summoning a full worker.
 *
 * @param {object} args
 * @param {string} args.prompt           User's raw task text.
 * @param {string[]} [args.available]    Hints (e.g., known agent names) for the classifier.
 * @param {number} [args.timeoutMs=2000] Hard timeout. Fail-open on timeout.
 * @param {object} [args.deps]           Injection point for tests: {anthropicClient}.
 * @returns {Promise<{is_vague: boolean, gap_signals: string[]}>}
 */
async function preflight({ prompt, available = [], timeoutMs = 2000, deps = {} }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ...FAIL_OPEN };
  }

  let timeoutHandle;
  try {
    let client;
    if (deps && deps.anthropicClient) {
      client = deps.anthropicClient;
    } else {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic();
    }

    const systemParts = [
      'You are a task-clarity classifier. Given a user task, respond with JSON only, no other text.',
      'Schema: {"is_vague": boolean, "gap_signals": string[]}.',
      'is_vague is true when the task lacks sufficient information to proceed.',
      'gap_signals lists the missing pieces (e.g. "audience", "format", "scope").',
    ];
    if (available && available.length) {
      systemParts.push(`Available agents: ${available.join(', ')}.`);
    }

    const apiCall = client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemParts.join(' '),
      messages: [{ role: 'user', content: prompt }],
    });

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('preflight timeout')), timeoutMs);
    });

    const response = await Promise.race([apiCall, timeoutPromise]);
    clearTimeout(timeoutHandle);

    const parsed = JSON.parse(response.content[0].text);
    return {
      is_vague: Boolean(parsed.is_vague),
      gap_signals: Array.isArray(parsed.gap_signals) ? parsed.gap_signals : [],
    };
  } catch {
    clearTimeout(timeoutHandle);
    return { ...FAIL_OPEN };
  }
}

module.exports = { preflight };
