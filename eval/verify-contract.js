const path = require('path')
const { spawnSync } = require('child_process')

const modDir = process.argv[2]
const src = path.join(modDir, 'src', 'mapLimit.js')
const { mapLimit } = require(src)
const out = []
const log = (k, ok, d='') => out.push(`${ok?'PASS':'FAIL'} ${k} ${d}`)

// Literal-source injection (not JSON) so NaN/Infinity/undefined/{} survive into
// the child snippet unchanged - JSON.stringify(NaN) === "null", which would
// silently swap the probed value. Anything that can't be rendered as an exact
// source literal (arrays, non-plain objects, functions, symbols, bigints, or a
// non-empty plain object) throws instead of degrading to "{}", so a future
// limit case that isn't losslessly representable fails loudly rather than
// silently probing the wrong value and reporting a false PASS.
function literalOf(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'number') {
    if (Number.isNaN(v)) return 'NaN'
    if (v === Infinity) return 'Infinity'
    if (v === -Infinity) return '-Infinity'
    if (Object.is(v, -0)) return '-0'
    return String(v)
  }
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`literalOf: cannot represent ${t} value as a source literal: ${String(v)}`)
  }
  if (t === 'object') {
    if (Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) {
      throw new Error(`literalOf: cannot represent ${Object.prototype.toString.call(v)} as a source literal`)
    }
    if (Object.keys(v).length > 0) {
      throw new Error(`literalOf: cannot represent non-empty plain object as a source literal: ${JSON.stringify(v)}`)
    }
    return '{}'
  }
  return JSON.stringify(v)
}

const CLAUSE5_TIMEOUT_MS = 2000

function probeClause5(lim) {
  const snippet = `
    const { mapLimit } = require(${JSON.stringify(src)})
    ;(async () => {
      try {
        await mapLimit([1,2,3], ${literalOf(lim)}, async x => x)
        console.log(JSON.stringify({ outcome: 'resolved(no error)' }))
      } catch (e) {
        console.log(JSON.stringify({ outcome: e instanceof TypeError ? 'TypeError' : 'Other:' + e.constructor.name, message: e.message }))
      }
    })()
  `
  const run = spawnSync(process.execPath, ['-e', snippet], { timeout: CLAUSE5_TIMEOUT_MS, encoding: 'utf8' })
  if (run.signal || run.error) return 'HANG'
  try {
    const parsed = JSON.parse((run.stdout || '').trim())
    return parsed.outcome
  } catch (e) {
    return 'Other:ParseError'
  }
}

const CLAUSE6_FAILFAST_TIMEOUT_MS = 2000

function probeClause6FailFast() {
  // Constructs the case the in-process c6 checks below cannot: a worker
  // rejects while a sibling is still pending and will NEVER settle. A
  // fail-fast implementation rejects promptly without waiting on the
  // sibling, so this subprocess exits quickly. A deferred-rejection
  // implementation (e.g. Promise.all over per-slot runner loops) blocks
  // forever on the never-settling sibling, so the subprocess hangs and is
  // killed by spawnSync's timeout - reported as HANG, same as clause 5.
  const snippet = `
    const { mapLimit } = require(${JSON.stringify(src)})
    ;(async () => {
      try {
        await mapLimit([0,1], 2, async (item, i) => {
          if (i === 0) {
            await new Promise(r => setTimeout(r, 10))
            throw new Error('boom-failfast')
          }
          return new Promise(() => {}) // sibling: never settles
        })
        console.log(JSON.stringify({ outcome: 'resolved(no error)' }))
      } catch (e) {
        console.log(JSON.stringify({ outcome: 'rejected', message: e.message }))
      }
    })()
  `
  const run = spawnSync(process.execPath, ['-e', snippet], { timeout: CLAUSE6_FAILFAST_TIMEOUT_MS, encoding: 'utf8' })
  if (run.signal || run.error) return { outcome: 'HANG' }
  try {
    return JSON.parse((run.stdout || '').trim())
  } catch (e) {
    return { outcome: 'Other:ParseError' }
  }
}

// Clause 6: same-microtask-drain race. Every worker here settles within one
// microtask drain (no setTimeout anywhere), so a candidate that sets its
// failure flag in an outer .catch() instead of synchronously at the throw
// site lets a sibling resuming from its own await start an extra item before
// the flag is visible. Guarded with a race against a timer so a pathological
// candidate cannot wedge this process.
async function probeClause6Microtask() {
  const started = []
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 2000))
  try {
    await Promise.race([
      mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (item, i) => {
        started.push(i)
        if (i === 0) throw new Error('boom')
        return i
      }),
      guard,
    ])
  } catch (e) { /* expected: boom, or TIMEOUT on a wedged candidate */ }
  return started
}

;(async () => {
  // Clause 5: invalid limits -> TypeError, no hang. Each limit is probed in its
  // own subprocess (spawnSync + timeout) so a candidate that spins in an
  // in-process infinite microtask loop (e.g. a batching `for` loop that never
  // advances at limit=0) cannot starve this process's own timer phase and wedge
  // the whole run; a wedged subprocess is killed and reported as HANG, a per-case
  // failure, instead of hanging verify-contract.js itself.
  for (const lim of [0, -1, 1.5, NaN, Infinity, '2', null, undefined, {}, -0]) {
    const r = probeClause5(lim)
    log('c5 limit='+String(lim), r==='TypeError', r)
  }
  // Clause 6: rejects with THAT error, no further invocations
  const err = new Error('boom'); const calls = []
  let caught
  try { await mapLimit([0,1,2,3,4,5], 2, async (item,i)=>{ calls.push(i); if(i===2) throw err; await new Promise(r=>setTimeout(r,10)); return i }) }
  catch(e){ caught = e }
  await new Promise(r=>setTimeout(r,60))
  log('c6 same error identity', caught===err, String(caught && caught.message))
  log('c6 no starts after failure', Math.max(...calls)<=2 && calls.length<=3, 'calls='+JSON.stringify(calls))
  const c6ff = probeClause6FailFast()
  log('c6 fail-fast (rejects without waiting for a still-pending sibling)', c6ff.outcome === 'rejected' && c6ff.message === 'boom-failfast', JSON.stringify(c6ff))
  const c6mt = await probeClause6Microtask()
  const c6mtExtra = c6mt.filter((i) => i > 1).length
  log('c6 no extra item within same microtask drain after same-tick rejection', c6mtExtra === 0, 'started=' + JSON.stringify(c6mt))
  // Clause 1: worker called exactly once per entry
  const seen = new Map()
  await mapLimit([...Array(20).keys()], 4, async (item,i)=>{ seen.set(i,(seen.get(i)||0)+1); return i })
  log('c1 once per entry', seen.size===20 && [...seen.values()].every(v=>v===1), 'size='+seen.size)
  // Clause 2: input order with random completion times
  const res = await mapLimit([...Array(15).keys()], 3, async (n)=>{ await new Promise(r=>setTimeout(r, (15-n)*3)); return n*2 })
  log('c2 input order', JSON.stringify(res)===JSON.stringify([...Array(15).keys()].map(n=>n*2)), JSON.stringify(res))
  // Clause 3+4: peak concurrency == limit and stays saturated with one slow item
  let inFlight=0, peak=0; const timeline=[]
  await mapLimit([...Array(10).keys()], 3, async (n)=>{ inFlight++; peak=Math.max(peak,inFlight); timeline.push(inFlight); await new Promise(r=>setTimeout(r, n===0?120:5)); inFlight--; return n })
  log('c3 peak<=limit', peak<=3, 'peak='+peak)
  log('c4 saturated (peak reached limit, slow item did not stall)', peak===3 && timeline.filter(v=>v===3).length>=5, 'atLimitTicks='+timeline.filter(v=>v===3).length)
  // sync-throwing worker
  let st; try { await mapLimit([1,2],1,()=>{ throw new TypeError('sync') }) } catch(e){ st=e.message }
  log('c6 sync-throw rejects', st==='sync', String(st))
  console.log(out.join('\n'))
  console.log('FAILURES=' + out.filter(l=>l.startsWith('FAIL')).length)
})()
