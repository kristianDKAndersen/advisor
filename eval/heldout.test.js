'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mapLimit } = require('../src/mapLimit.js')

const tick = () => new Promise((r) => setImmediate(r))
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick()
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// H1 — order under out-of-order completion. Green on both seeds; kept as a cheap
// guard against a pool that pushes results as they land. Carries little signal.
test('H1 order is preserved when workers finish out of order', async () => {
  const d = [0, 1, 2].map(() => deferred())
  const p = mapLimit([0, 1, 2], 3, (i) => d[i].promise)
  await flush()
  d[2].resolve('c')
  d[0].resolve('a')
  d[1].resolve('b')
  assert.deepEqual(await p, ['a', 'b', 'c'])
})

// H2 — contract clause 6. Green on the Run 1 seed, RED on the Run 2 seed.
test('H2 rejects with the first error and starts no further work', async () => {
  const d = [0, 1, 2, 3].map(() => deferred())
  const started = []
  const p = mapLimit([0, 1, 2, 3], 2, (i) => {
    started.push(i)
    return d[i].promise
  })
  await flush()
  const boom = new Error('boom')
  d[0].reject(boom)
  await assert.rejects(p, (e) => e === boom)
  const seenAtFailure = started.length
  d[1].resolve('b')
  await flush()
  assert.equal(started.length, seenAtFailure, 'no new work may start after a rejection')
})

// H3 — contract clause 5. RED on both seeds. Subprocess-guarded so a hang is
// reported as a failure instead of wedging the run.
test('H3 an invalid limit is rejected, and never hangs', () => {
  const src = require.resolve('../src/mapLimit.js')
  const snippet = `
    const { mapLimit } = require(${JSON.stringify(src)})
    const bad = [0, -1, 1.5, NaN, '2', null, undefined, Infinity]
    ;(async () => {
      const out = []
      for (const limit of bad) {
        try {
          await mapLimit([1, 2, 3], limit, async (n) => n)
          out.push([String(limit), 'RESOLVED'])
        } catch (e) {
          out.push([String(limit), (e && e.name) || 'threw'])
        }
      }
      console.log(JSON.stringify(out))
    })()
  `
  const run = spawnSync(process.execPath, ['-e', snippet], { timeout: 5000, encoding: 'utf8' })
  assert.equal(run.signal, null, 'mapLimit hung on an invalid limit — the process had to be killed')
  const rows = JSON.parse(run.stdout.trim())
  for (const [limit, outcome] of rows) {
    assert.equal(outcome, 'TypeError', `limit=${limit} should reject with a TypeError, got ${outcome}`)
  }
})
