'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
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

test('resolves to the results in input order', async () => {
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10)
  assert.deepEqual(out, [10, 20, 30, 40, 50])
})

test('passes (item, index) to the worker', async () => {
  const seen = []
  await mapLimit(['a', 'b', 'c'], 2, async (item, i) => {
    seen.push([item, i])
  })
  seen.sort((x, y) => x[1] - y[1])
  assert.deepEqual(seen, [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ])
})

test('empty input resolves to [] and never calls the worker', async () => {
  let calls = 0
  const out = await mapLimit([], 3, async () => {
    calls++
  })
  assert.deepEqual(out, [])
  assert.equal(calls, 0)
})

test('never runs more than `limit` workers at once', async () => {
  let inFlight = 0
  let peak = 0
  await mapLimit([...Array(12).keys()], 3, async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await tick()
    inFlight--
  })
  assert.equal(peak, 3)
})

test('keeps the pool saturated: a freed slot starts the next item immediately', async () => {
  const d = [0, 1, 2, 3, 4].map(() => deferred())
  const started = []
  const p = mapLimit([0, 1, 2, 3, 4], 2, (item) => {
    started.push(item)
    return d[item].promise
  })
  p.catch(() => {})

  await flush()
  assert.deepEqual(started, [0, 1], 'both slots filled at the start')

  d[1].resolve('b')
  await flush()
  assert.deepEqual(started, [0, 1, 2], 'item 2 must start as soon as slot 1 frees, while item 0 still runs')

  d[0].resolve('a')
  d[2].resolve('c')
  await flush()
  assert.deepEqual(started, [0, 1, 2, 3, 4])

  d[3].resolve('d')
  d[4].resolve('e')
  assert.deepEqual(await p, ['a', 'b', 'c', 'd', 'e'])
})
