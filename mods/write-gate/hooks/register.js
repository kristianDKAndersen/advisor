// Default threshold mirrors the doctrine's "Large-artifact patch rule": 50KB.
const MAX_WRITE_BYTES = 51200

export function register(on) {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (typeof e.content !== 'string') return next(e)

    const bytes = new TextEncoder().encode(e.content).length
    if (bytes > MAX_WRITE_BYTES) {
      return {
        deny:
          `Write content is ${bytes} bytes, over the ${MAX_WRITE_BYTES}-byte limit. ` +
          'Write a skeleton under 30KB with Write, then append each section with Edit.',
      }
    }

    return next(e)
  })
}
