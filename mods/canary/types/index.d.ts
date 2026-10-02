declare module 'claude-code' {
  interface PluginState {
    canary: {
      booted: boolean
      reloads: number
      beats: number
      startedAt: number
      registerCounts: Record<string, number>
      toasted: Record<string, boolean>
    }
  }
}
