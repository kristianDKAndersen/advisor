'use strict'

/**
 * Run `worker(item, index)` over every entry of `items`, with at most `limit`
 * workers in flight at any moment. Resolves to the results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = []
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit)
    const settled = await Promise.all(batch.map((item, j) => worker(item, i + j)))
    results.push(...settled)
  }
  return results
}

module.exports = { mapLimit }
