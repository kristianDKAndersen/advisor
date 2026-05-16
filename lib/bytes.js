function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) {
    throw new TypeError('formatBytes: n must be a finite number');
  }
  if (n < 0) {
    throw new TypeError('formatBytes: n must be non-negative');
  }
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (n >= GB) return `${Math.floor(n / GB)}GB`;
  if (n >= MB) return `${Math.floor(n / MB)}MB`;
  if (n >= KB) return `${Math.floor(n / KB)}KB`;
  return `${n}B`;
}

module.exports = { formatBytes };
