// lib/loop-bar.js
// Resolves the comparison bar for the loop's blind A/B judging protocol
// (advisor-loop-design.md §4). If no bar can be declared, the loop must not
// silently degrade into rubric self-scoring — resolveBar throws NoBarError.

class NoBarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoBarError';
    this.exitCode = 6;
  }
}

/**
 * Resolve the round_state.bar descriptor.
 *
 * @param {object} opts
 * @param {string} [opts.barType] - explicit --bar-type flag
 * @param {string} [opts.barRef] - explicit --bar-ref flag
 * @param {object} [opts.spec] - spec phase result body (may have test_command)
 * @param {boolean} [opts.refine] - --refine flag
 * @param {object} [opts.priorRoundArtifacts] - rounds[n-1].artifacts, required for prior-round bar
 * @returns {{type: 'external-reference'|'acceptance-tests'|'prior-round', ref: *}}
 * @throws {NoBarError} if no bar can be resolved
 */
function resolveBar(opts = {}) {
  const { barType, barRef, spec, refine, priorRoundArtifacts } = opts;

  // 1. Explicit --bar-type + --bar-ref flags.
  if (barType && barRef !== undefined && barRef !== null) {
    if (barType === 'metric') {
      throw new NoBarError(
        'bar-type "metric" can never be satisfied: no field or pipeline ever writes a measured metric value (roundRecord.metric_value has no producer), so the bar would never be met and the loop would silently burn every round instead of refusing up front — use "acceptance-tests" with a test command instead',
      );
    }
    if (!['external-reference', 'acceptance-tests', 'prior-round'].includes(barType)) {
      throw new NoBarError(`unknown bar-type "${barType}"`);
    }
    return { type: barType, ref: barRef };
  }

  // 2. Spec with a test_command -> acceptance-tests bar.
  if (spec && typeof spec === 'object' && spec.test_command) {
    return { type: 'acceptance-tests', ref: spec.test_command };
  }

  // 3. --refine -> prior-round bar, seeded from round 0's artifacts.
  if (refine) {
    if (!priorRoundArtifacts) {
      throw new NoBarError(
        'no comparison bar could be declared for this task; --refine requires round 0 artifacts to seed a prior-round bar',
      );
    }
    return { type: 'prior-round', ref: priorRoundArtifacts };
  }

  throw new NoBarError(
    'no comparison bar could be declared for this task; blind A/B would degrade to rubric scoring — supply --bar-type/--bar-ref or a spec with a test_command',
  );
}

module.exports = { resolveBar, NoBarError };
