'use strict'

/**
 * Run `worker(item, index)` over every entry of `items`, with at most `limit`
 * workers in flight at any moment. Resolves to the results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

module.exports = { mapLimit }
