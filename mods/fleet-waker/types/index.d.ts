declare module 'claude-code' {
  interface PluginState {
    'fleet-waker': {
      watches: Record<string, { sid: string; agent: string; outbox: string; lastSeq: number; addedAt: number }>
      instanceId: string
    }
  }
}
