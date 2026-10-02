import { expect, test, mock } from 'claude-code/testing'
import { churnStep, __simulateReload } from '../hooks/register.js'

test('beat writes hb:<id> with expected fields', async ($, on) => {
  const store = new Map()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Array.from(store.keys()) }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', () => ({ cwd: '/work' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/work' })

  const hb = store.get('hb:sess-1')
  expect(hb).toMatchObject({ beats: 1, reloads: 0, cwd: '/work', registered: {} })
  expect(typeof hb.ts).toBe('number')
  expect(typeof hb.startedAt).toBe('number')
})

test('clock tick updates ts and beats', async ($, on) => {
  const store = new Map()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Array.from(store.keys()) }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-2' }))
  on('session.start', () => ({ cwd: '/work' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/work' })
  const first = store.get('hb:sess-2')
  await clock.advance(30000)
  const second = store.get('hb:sess-2')

  expect(second.beats).toBe(first.beats + 1)
  expect(second.ts).toBeGreaterThan(first.ts)
})

test('stale keys over 24h are pruned, fresh kept, other sessions untouched', async ($, on) => {
  const store = new Map()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Array.from(store.keys()) }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-3' }))
  on('session.start', () => ({ cwd: '/work' }))
  const clock = mock.clock(on, { now: 100_000_000 })

  store.set('hb:stale', { ts: 1, startedAt: 1, beats: 1, reloads: 0, cwd: '/x' })
  store.set('hb:fresh-other', { ts: 99_999_000, startedAt: 1, beats: 1, reloads: 0, cwd: '/y' })

  await $.session.start({ cwd: '/work' })

  expect(store.has('hb:stale')).toBe(false)
  expect(store.has('hb:fresh-other')).toBe(true)
})

test('repeat session.start within one loaded instance is not miscounted as a reload', async ($, on) => {
  const store = new Map()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Array.from(store.keys()) }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-4' }))
  on('session.start', () => ({ cwd: '/work' }))
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/work' })
  expect(store.get('hb:sess-4').reloads).toBe(0)

  await $.session.start({ cwd: '/work' })
  expect(store.get('hb:sess-4').reloads).toBe(0)

  await clock.advance(30000)
  expect(store.get('hb:sess-4').beats).toBeGreaterThan(1)
})

// churnStep is a pure function (no `$`), so it can be driven directly without
// going through the engine's per-test module graph. These are the real
// red/green-able tests for the churn-toast decision logic that onRegister
// delegates to.
test('churnStep: 3rd call for a name toasts exactly once, 4th stays silent', () => {
  let counts = {}
  let toasted = {}

  let step = churnStep(counts, toasted, 'flaky-mod')
  counts = step.counts
  toasted = step.toasted
  expect(step.toast).toBeNull()

  step = churnStep(counts, toasted, 'flaky-mod')
  counts = step.counts
  toasted = step.toasted
  expect(step.toast).toBeNull()

  step = churnStep(counts, toasted, 'flaky-mod')
  counts = step.counts
  toasted = step.toasted
  expect(step.toast).toMatch(/flaky-mod/)
  expect(step.toast).toMatch(/reload-plugins/)

  step = churnStep(counts, toasted, 'flaky-mod')
  expect(step.toast).toBeNull()
})

test('churnStep: a different name registering twice stays silent', () => {
  let counts = {}
  let toasted = {}

  let step = churnStep(counts, toasted, 'quiet-mod')
  counts = step.counts
  toasted = step.toasted
  expect(step.toast).toBeNull()

  step = churnStep(counts, toasted, 'quiet-mod')
  expect(step.toast).toBeNull()
})

// Regression test for the field-name bug: v1 read `e.plugin`, which does not
// exist on PluginRegisterInput ({ name, tier, root, version?, provenance,
// uses }), so a registering companion mod was never counted and the churn
// toast could never fire. `plugin.register` fires once per loaded mod
// (verified: loading a companion via `{ plugins: [...] }` drives it), so
// this exercises the real hook end to end through `$.session.start`, with
// the observable surfaced in the heartbeat's `registered` field.
const flakyMod = { name: 'flaky-mod', register() {} }

test('a companion mod loading is counted under its PluginRegisterInput.name in the heartbeat', { plugins: [flakyMod] }, async ($, on) => {
  const store = new Map()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Array.from(store.keys()) }))
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-companion' }))
  on('session.start', () => ({ cwd: '/work' }))
  mock.clock(on)

  await $.session.start({ cwd: '/work' })

  const hb = store.get('hb:sess-companion')
  expect(hb.registered).toMatchObject({ 'flaky-mod': 1 })
})

test('a thrown store error does not propagate', async ($, on) => {
  on('store.get', () => {
    throw new Error('store is down')
  })
  on('store.set', () => {
    throw new Error('store is down')
  })
  on('store.keys', () => {
    throw new Error('store is down')
  })
  on('store.delete', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-5' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.log', () => ({ value: undefined }))
  mock.clock(on)

  const result = await $.session.start({ cwd: '/work' })
  expect(result).toBeDefined()
})
