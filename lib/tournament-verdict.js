function handleSpecVerdict(body) {
  if (!body || typeof body !== 'object') {
    return { exitCode: 2, message: 'spec agent result body is not a JSON object' };
  }
  if (body.verdict === 'blocked') {
    return { exitCode: 5, message: 'spec phase blocked — internal inconsistency' };
  }
  if (body.verdict !== 'complete') {
    const summary = body.summary || '';
    return {
      exitCode: 2,
      message: `spec agent verdict is "${body.verdict}", expected "complete"${summary ? `. summary: ${summary}` : ''}`,
    };
  }
  if (!body.test_command) {
    return { exitCode: 2, message: 'spec agent result body is missing required field: test_command' };
  }
  return { exitCode: 0, message: null };
}

module.exports = { handleSpecVerdict };
