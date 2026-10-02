// Default threshold mirrors the doctrine's "Large-artifact patch rule": 50KB.
const DEFAULT_MAX_WRITE_BYTES = 51200
// Upper cap: a configured value above 10 MiB is rejected as almost certainly
// a mistake (e.g. a byte/KB unit mix-up), falling back to the default instead.
const MAX_ALLOWED_MAX_WRITE_BYTES = 10 * 1024 * 1024

// Pure decision step: resolves the effective byte limit from plugin options,
// falling back to the default for anything not a finite integer in range.
export function resolveLimit(options) {
  const value = options && options.maxWriteBytes
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= MAX_ALLOWED_MAX_WRITE_BYTES
  ) {
    return { limit: value, reason: null }
  }
  return {
    limit: DEFAULT_MAX_WRITE_BYTES,
    reason: `maxWriteBytes option ${JSON.stringify(value)} is not a finite integer in [1024, ${MAX_ALLOWED_MAX_WRITE_BYTES}]; falling back to ${DEFAULT_MAX_WRITE_BYTES}`,
  }
}

function safeLog($, reason) {
  try {
    $.ui.log('write-gate: ' + reason, { to: 'debug' })
  } catch {
    // logging must never itself throw
  }
}

export function register(on, options) {
  const { limit, reason } = resolveLimit(options)
  let loggedFallback = false

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (reason && !loggedFallback) {
      loggedFallback = true
      safeLog($, reason)
    }
    if (typeof e.content !== 'string') return next(e)

    const bytes = new TextEncoder().encode(e.content).length
    if (bytes > limit) {
      return {
        deny:
          `Write content is ${bytes} bytes, over the ${limit}-byte limit. ` +
          'Write a skeleton under 30KB with Write, then append each section with Edit.',
      }
    }

    return next(e)
  })
}
