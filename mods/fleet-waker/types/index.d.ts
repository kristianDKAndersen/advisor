declare module 'claude-code' {
  interface PluginState {
    'fleet-waker': {
      watches: Record<
        string,
        {
          sid: string
          agent: string
          outbox: string
          lastSeq: number
          addedAt: number
          lastStat?: { size: number; mtimeMs: number }
          pending?: Array<{ seq: number; type: string; ts: number; body?: unknown }>
          lastEventType?: string
        }
      >
      instanceId: string
      fleetSummary: Array<{
        sid: string
        agent: string
        addedAt: number
        lastEventType?: string
        pendingGrace: boolean
      }>
    }
  }
}
