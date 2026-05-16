function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError('formatDuration: ms must be a finite number');
  }
  if (ms < 0) {
    throw new TypeError('formatDuration: ms must be non-negative');
  }
  ms = Math.floor(ms);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor(ms / 1000) % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  return `${h}h ${m}m`;
}

module.exports = { formatDuration };
