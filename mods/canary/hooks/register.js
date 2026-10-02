import { atom, read, update } from 'claude-code'

const HEARTBEAT_MS = 30000
const STALE_MS = 24 * 60 * 60 * 1000
const MAX_PRUNE_KEYS = 500
const CHURN_THRESHOLD = 3

const booted = atom({ plugin: 'canary', key: 'booted' }, false)
// `reloads` also counts hooks-worker respawns (e.g. a crash restart), not only file-save reloads.
const reloads = atom({ plugin: 'canary', key: 'reloads' }, 0)
const beats = atom({ plugin: 'canary', key: 'beats' }, 0)
const startedAt = atom({ plugin: 'canary', key: 'startedAt' }, 0)
const registerCounts = atom({ plugin: 'canary', key: 'registerCounts' }, {})
const toasted = atom({ plugin: 'canary', key: 'toasted' }, {})

// Module-level: resets on every reload, unlike $.state - the gap between the
// two is how a reload is detected (see onBoot).
let bootedThisLoad = false
let timer = null

function safeLog($, reason) {
  try {
    $.ui.log('canary: ' + reason, { to: 'debug' })
  } catch {
    // logging must never itself throw
  }
}

async function beat($, cwd) {
  try {
    const sid = String(await $.session.id())
    const now = await $.clock.now()
    const b = (await read($, beats)) + 1
    await update($, beats, () => b)
    const r = await read($, reloads)
    const sa = await read($, startedAt)
    const registered = await read($, registerCounts)
    await $.store.set('hb:' + sid, { ts: now, startedAt: sa, beats: b, reloads: r, registered, cwd })
  } catch (err) {
    safeLog($, 'beat failed: ' + (err && err.message))
  }
}

function startTimer($, cwd) {
  try {
    if (timer) timer.cancel()
    timer = $.clock.every(HEARTBEAT_MS, () => beat($, cwd))
  } catch (err) {
    safeLog($, 'startTimer failed: ' + (err && err.message))
  }
}

async function prune($) {
  try {
    const now = await $.clock.now()
    const allKeys = await $.store.keys()
    const hbKeys = allKeys.filter((k) => k.startsWith('hb:')).slice(0, MAX_PRUNE_KEYS)
    for (const key of hbKeys) {
      const value = await $.store.get(key)
      if (value && typeof value.ts === 'number' && now - value.ts > STALE_MS) {
        await $.store.delete(key)
      }
    }
  } catch (err) {
    safeLog($, 'prune failed: ' + (err && err.message))
  }
}

export async function onBoot($, cwd) {
  try {
    const now = await $.clock.now()
    const already = await read($, booted)
    if (already && !bootedThisLoad) {
      // Module-level flag reset (reload) but $.state remembers this session booted already.
      await update($, reloads, (n) => n + 1)
    } else if (!already) {
      await update($, booted, () => true)
      await update($, startedAt, () => now)
    }
    bootedThisLoad = true
    await prune($)
    startTimer($, cwd)
    await beat($, cwd)
  } catch (err) {
    safeLog($, 'onBoot failed: ' + (err && err.message))
  }
}

// Pure decision step, no `$` - directly unit-testable without the engine.
export function churnStep(counts, toastedMap, name) {
  const count = (counts[name] || 0) + 1
  const nextCounts = { ...counts, [name]: count }
  if (count >= CHURN_THRESHOLD && !toastedMap[name]) {
    return {
      counts: nextCounts,
      toasted: { ...toastedMap, [name]: true },
      toast:
        name +
        ' has registered ' +
        count +
        ' times this session. Repeated reloads/crashes can trip the ' +
        '3-crash rule that disables all mods. Run /reload-plugins if mods stop responding.',
    }
  }
  return { counts: nextCounts, toasted: toastedMap, toast: null }
}

// PluginRegisterInput's mod-name field is `name` (falls back to `provenance`
// when a load path leaves `name` empty), not `plugin` - see changes.md bug fix.
export async function onRegister($, name) {
  if (!name) return
  try {
    const counts = await read($, registerCounts)
    const toastedMap = await read($, toasted)
    const next = churnStep(counts, toastedMap, name)
    await update($, registerCounts, () => next.counts)
    if (next.toast) {
      await update($, toasted, () => next.toasted)
      await $.ui.toast(next.toast)
    }
  } catch (err) {
    safeLog($, 'plugin.register failed: ' + (err && err.message))
  }
}

// Test-only: undoes what a real module reload does to module-level state,
// so tests can exercise the reload path without the test kit's module graph.
export function __simulateReload() {
  bootedThisLoad = false
  if (timer) {
    try {
      timer.cancel()
    } catch {
      // already cancelled or invalid - nothing to clean up
    }
    timer = null
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await onBoot($, e && e.cwd)
    } catch (err) {
      safeLog($, 'session.start hook failed: ' + (err && err.message))
    }
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await onBoot($, e && e.cwd)
    } catch (err) {
      safeLog($, 'classic.SessionStart hook failed: ' + (err && err.message))
    }
    return next(e)
  })

  on('plugin.register', async ($, e, next) => {
    try {
      const name = (e && e.name) || (e && e.provenance)
      await onRegister($, name)
    } catch (err) {
      safeLog($, 'plugin.register hook failed: ' + (err && err.message))
    }
    return next(e)
  })
}
