import { atom, read, update } from 'claude-code'

const POLL_MS = 5000
const MAX_WATCHES = 20
const STALE_MS = 6 * 60 * 60 * 1000
const GRACE_MS = 30000
const DAY_MS = 24 * 60 * 60 * 1000
const STORE_SCAN_CAP = 500
const SID_RE = /^\d{10}-[0-9a-f]{6}$/

const watches = atom({ plugin: 'fleet-waker', key: 'watches' }, {})
const instanceIdAtom = atom({ plugin: 'fleet-waker', key: 'instanceId' }, '')
const fleetSummaryAtom = atom({ plugin: 'fleet-waker', key: 'fleetSummary' }, [])
const MAX_BAND_ROWS = 5

// Module-level: reset on reload, unlike $.state/$.store (mirrors canary's pattern).
let timer = null
let moduleInstanceId = null
let moduleRunsRoot = null

function safeLog($, reason) {
  try {
    $.ui.log('fleet-waker: ' + reason, { to: 'debug' })
  } catch {
    // logging must never itself throw
  }
}

function joinPath(root, ...parts) {
  return root.replace(/[\\/]+$/, '') + '/' + parts.join('/')
}

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

// ─── Pure functions (directly unit-testable, no `$`) ───────────────────────

// Whether a watch's outbox needs a fs.read this tick: no prior stat or a
// failed stat (caller passes null) always reads; otherwise only size/mtime
// drift triggers a read.
export function shouldRead(prev, stat) {
  if (!stat) return true
  if (!prev) return true
  return stat.size !== prev.size || stat.mtimeMs !== prev.mtimeMs
}

// First 6 chars after the sid's dash (the hex suffix itself, for a real sid).
export function shortSid(sid) {
  const s = String(sid)
  const i = s.indexOf('-')
  return i >= 0 ? s.slice(i + 1, i + 7) : s.slice(0, 6)
}

// Minutes (then hours+minutes past 60) since a timestamp, e.g. "3m", "2h5m".
export function formatAge(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000))
  if (totalMin < 60) return totalMin + 'm'
  return Math.floor(totalMin / 60) + 'h' + (totalMin % 60) + 'm'
}

// One line per worker (sid, agent, age, last event type, grace note), capped
// at MAX_BAND_ROWS with a "+N more" summary row; [] for zero workers hides
// the band entirely (the render hook returns the untouched base tree then).
export function formatFleetLines(watchList, nowMs) {
  const list = Array.isArray(watchList) ? watchList : []
  const shown = list.slice(0, MAX_BAND_ROWS).map((w) => {
    const bits = [shortSid(w.sid), w.agent, formatAge(nowMs - w.addedAt)]
    if (w.lastEventType) bits.push(w.lastEventType)
    if (w.pendingGrace) bits.push('waiting grace')
    return bits.join(' ')
  })
  if (list.length > MAX_BAND_ROWS) shown.push('+' + (list.length - MAX_BAND_ROWS) + ' more')
  return shown
}

// A worker's cwd is ~/.advisor/runs/<sid>/workspace or ~/.advisor/slots/<name>,
// or the session has ADVISOR_SID set (set in every worker's env regardless of cwd).
export function isWorkerSession(cwd, advisorSid) {
  if (typeof advisorSid === 'string' && advisorSid) return true
  if (typeof cwd !== 'string') return false
  return /[\\/]\.advisor[\\/](runs[\\/][^\\/]+[\\/]workspace|slots[\\/][^\\/]+)([\\/]|$)/.test(cwd)
}

// Matches a Bash command that invokes bin/summon, excluding --help/-h.
export function isSummonCommand(command) {
  if (typeof command !== 'string') return false
  if (!/\bbin\/summon\b/.test(command)) return false
  if (/--help\b/.test(command) || /(^|\s)-h(\s|$)/.test(command)) return false
  return true
}

// Caps: a watched outbox/log path must resolve under the resolved runs root
// (ADVISOR_RUNS_ROOT, which need not contain the literal ".advisor/runs"
// substring), with no `..` traversal segments and on a real segment boundary
// (so a sibling dir like "runs-evil" next to "runs" is never mistaken for it).
export function isUnderRunsRoot(p, runsRoot) {
  if (typeof p !== 'string' || !p) return false
  if (typeof runsRoot !== 'string' || !runsRoot) return false
  if (p.split(/[\\/]/).includes('..')) return false
  const normRoot = runsRoot.replace(/[\\/]+$/, '')
  if (!normRoot) return false
  const normPath = p.replace(/[\\/]+$/, '')
  return normPath === normRoot || normPath.startsWith(normRoot + '/')
}

// Strict run-dir naming: <epochSeconds (10 digits)>-<6 lowercase hex>. Rejects
// sibling entries that aren't worker runs (plans, researcher-1, ...) and any
// case-alias (only lowercase hex is a real sid, per bin/summon/lib/summon.js).
export function isStrictSidDir(name) {
  return typeof name === 'string' && SID_RE.test(name)
}

// The epoch-seconds creation time encoded as the sid's own prefix.
export function sidEpoch(name) {
  return parseInt(String(name).slice(0, 10), 10)
}

// A discovered sid dir counts as "from this summon call" when its epoch
// prefix falls within [callStart-2, callEnd+2] (small clock-skew margin).
export function inEpochWindow(epoch, callStart, callEnd) {
  return epoch >= callStart - 2 && epoch <= callEnd + 2
}

// The post-`next()` shape for a real Bash tool.call, per the generated types
// (ToolCallResult<'Bash'> = { result: { stdout, stderr, ... } }). Falls back
// to looser shapes (a plain string, or a result that already is the record)
// so nothing is silently dropped if a stub/test uses a shorter shape.
export function extractResultText(result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    if (result.result && typeof result.result === 'object' && typeof result.result.stdout === 'string') {
      return result.result.stdout
    }
    if (typeof result.result === 'string') return result.result
    if (typeof result.stdout === 'string') return result.stdout
    if (typeof result.output === 'string') return result.output
  }
  try {
    return JSON.stringify(result)
  } catch {
    return ''
  }
}

// bin/summon's real stdout (lib/summon.js) is ONE pretty-printed
// `JSON.stringify(meta, null, 2)` object - solo `{sid, agent, outbox,...}` or
// ensemble `{batch:true, sessions:[{sid, agent, outbox,...}, ...]}` - not one
// JSON object per line. Tries a whole-text parse first (the common case),
// then falls back to a brace-balanced scan that tolerates noise text (e.g. a
// printed timeline URL) and multiple top-level objects in one blob.
export function parseSummonOutput(text) {
  const found = []
  if (!text) return found
  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (typeof obj.sid === 'string' && typeof obj.outbox === 'string') {
      found.push({ sid: obj.sid, agent: typeof obj.agent === 'string' ? obj.agent : 'unknown', outbox: obj.outbox })
    }
    if (Array.isArray(obj.sessions)) {
      for (const s of obj.sessions) {
        if (s && typeof s.sid === 'string' && typeof s.outbox === 'string') {
          found.push({ sid: s.sid, agent: typeof s.agent === 'string' ? s.agent : 'unknown', outbox: s.outbox })
        }
      }
    }
  }
  try {
    collect(JSON.parse(text))
    if (found.length) return found
  } catch {
    // not a single whole-text JSON document; fall through to the scan below
  }
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          try {
            collect(JSON.parse(text.slice(start, i + 1)))
          } catch {
            // noise, not JSON - skip
          }
          start = -1
        }
      }
    }
  }
  return found
}

// Same body-decoding rules as lib/channel.js's parseEnvelope: a result body
// may be stored as a JSON-encoded string or as a plain object.
export function parseEnvelope(body) {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

// Parses JSONL outbox content for lines with seq > lastSeq, skipping
// malformed lines. Terminal events: result, error; also wakes on question.
// lastSeq advances past every well-formed line seen, not just terminal ones,
// so progress messages don't get re-scanned every tick.
export function parseOutboxLines(content, lastSeq) {
  const events = []
  let maxSeq = lastSeq
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (!msg || typeof msg !== 'object' || typeof msg.seq !== 'number') continue
    if (msg.seq > maxSeq) maxSeq = msg.seq
    if (msg.seq <= lastSeq) continue
    if (msg.type === 'result' || msg.type === 'error' || msg.type === 'question') {
      events.push(msg)
    }
  }
  return { events, lastSeq: maxSeq }
}

// Same decoding as lib/channel.js's readSynthesisRecords: one JSON record
// per line, `{seq, sid, ts, established, gap, material, next_action, ...}`.
export function parseSynthesisLog(content) {
  const seqs = new Set()
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line)
      if (rec && typeof rec.seq === 'number') seqs.add(rec.seq)
    } catch {
      continue
    }
  }
  return seqs
}

// The true-fallback decision for one terminal (or question) event (spec item
// 3), pulled out as a pure function: 'wait' (too fresh, check again later),
// 'drop-silent' (grace-old result/error the Advisor already synthesized -
// stop watching, never wake), or 'consider-wake' (grace-old and not yet
// synthesized - proceed to the dedupe check).
export function evaluateTerminalEvent(msg, nowMs, synthesizedSeqs) {
  const ageMs = nowMs - msg.ts * 1000
  if (ageMs < GRACE_MS) return { action: 'wait' }
  const terminal = msg.type === 'result' || msg.type === 'error'
  if (terminal && synthesizedSeqs.has(msg.seq)) return { action: 'drop-silent' }
  return { action: 'consider-wake', terminal }
}

// Builds the single $.prompt.submit text for one tick's batch of wakes.
export function buildWakeText(wakes) {
  const lines = wakes.map((w) => {
    const envelope = parseEnvelope(w.msg.body)
    const rawSummary =
      envelope && typeof envelope.summary === 'string'
        ? envelope.summary
        : typeof w.msg.body === 'string'
          ? w.msg.body
          : JSON.stringify(w.msg.body)
    const summary = (rawSummary || '').slice(0, 200)
    const verdict = (envelope && envelope.verdict) || 'n/a'
    return (
      `- sid=${w.sid} agent=${w.agent} type=${w.msg.type} seq=${w.msg.seq} verdict=${verdict} ` +
      `summary="${summary}" outbox=${w.outbox}`
    )
  })
  return (
    `fleet-waker: ${wakes.length} worker${wakes.length === 1 ? '' : 's'} finished:\n` +
    lines.join('\n') +
    '\n\nSynthesize per Step 7 before any other action.'
  )
}

// ─── Engine-facing glue ─────────────────────────────────────────────────────

// $.state resets on /clear but module vars survive it; module vars reset on
// reload but $.state survives it. Keying watches by an id kept in BOTH closes
// the gap: whichever survived the last event still has the same id.
export async function resolveInstanceId($) {
  if (moduleInstanceId) return moduleInstanceId
  const stored = await read($, instanceIdAtom)
  const id = stored || randomId()
  moduleInstanceId = id
  if (!stored) await update($, instanceIdAtom, () => id)
  return id
}

// Resolved once per boot/reload and cached: $.env.get('ADVISOR_RUNS_ROOT'),
// falling back to $.env.get('HOME') + '/.advisor/runs' - the same precedence
// as lib/channel.js's runsRoot().
async function resolveRunsRoot($) {
  if (moduleRunsRoot) return moduleRunsRoot
  const envRoot = await $.env.get('ADVISOR_RUNS_ROOT')
  if (envRoot) {
    moduleRunsRoot = envRoot
    return moduleRunsRoot
  }
  const home = await $.env.get('HOME')
  moduleRunsRoot = (home || '') + '/.advisor/runs'
  return moduleRunsRoot
}

// Scans the runs root for sid dirs created during this summon call (spec
// item 1): the real discovery source, independent of stdout shape/redirects.
export async function discoverViaFsList($, runsRoot, callStart, callEnd) {
  const found = []
  let entries
  try {
    entries = await $.fs.list(runsRoot)
  } catch (err) {
    safeLog($, 'fs.list failed for runs root: ' + (err && err.message))
    return found
  }
  for (const entry of entries || []) {
    if (!entry || entry.kind !== 'dir') continue
    if (!isStrictSidDir(entry.name)) continue
    const epoch = sidEpoch(entry.name)
    if (!inEpochWindow(epoch, callStart, callEnd)) continue
    const sid = entry.name
    let agent = 'unknown'
    try {
      const metaText = await $.fs.read(joinPath(runsRoot, sid, 'meta.json'), { as: 'text' })
      const meta = JSON.parse(metaText)
      if (meta && typeof meta.agent === 'string') agent = meta.agent
    } catch {
      // meta.json may not exist yet for a just-created worker dir
    }
    found.push({ sid, agent, outbox: joinPath(runsRoot, sid, 'channel', 'outbox.jsonl') })
  }
  return found
}

async function loadWatches($, instanceId) {
  const keys = await $.store.keys()
  const prefix = 'watch:' + instanceId + ':'
  const out = {}
  let scanned = 0
  for (const k of keys) {
    if (scanned++ >= STORE_SCAN_CAP) break
    if (!k.startsWith(prefix)) continue
    const v = await $.store.get(k)
    if (v && typeof v.sid === 'string') out[v.sid] = v
  }
  return out
}

async function saveWatch($, instanceId, watch) {
  await $.store.set('watch:' + instanceId + ':' + watch.sid, watch)
}

async function dropWatch($, instanceId, sid) {
  await $.store.delete('watch:' + instanceId + ':' + sid)
}

// Drops the watch and sweeps its dedupe markers (spec item 4 housekeeping).
async function dropWatchAndWoke($, instanceId, sid) {
  await dropWatch($, instanceId, sid)
  const keys = await $.store.keys()
  const prefix = 'woke:' + sid + ':'
  let scanned = 0
  for (const k of keys) {
    if (scanned++ >= STORE_SCAN_CAP) break
    if (k.startsWith(prefix)) await $.store.delete(k)
  }
}

// Boot-time sweep of stale woke:/watch: keys (>24h old), bounded.
async function pruneStaleKeys($) {
  const keys = await $.store.keys()
  const now = await $.clock.now()
  let scanned = 0
  for (const k of keys) {
    if (scanned++ >= STORE_SCAN_CAP) break
    if (!k.startsWith('woke:') && !k.startsWith('watch:')) continue
    const v = await $.store.get(k)
    const ts = v && typeof v === 'object' ? (typeof v.ts === 'number' ? v.ts : v.addedAt) : undefined
    if (typeof ts === 'number' && now - ts > DAY_MS) {
      await $.store.delete(k)
    }
  }
}

async function readSynthesizedSeqs($, runsRoot, sid) {
  const p = joinPath(runsRoot, sid, 'synthesis.log')
  if (!isUnderRunsRoot(p, runsRoot)) return new Set()
  try {
    const content = await $.fs.read(p, { as: 'text' })
    return parseSynthesisLog(content)
  } catch {
    return new Set()
  }
}

async function syncState($, instanceId) {
  const map = await loadWatches($, instanceId)
  await update($, watches, () => map)
  const n = Object.keys(map).length
  try {
    $.ui.status(n > 0 ? 'fleet: ' + n + ' in flight' : undefined)
  } catch (err) {
    safeLog($, 'status failed: ' + (err && err.message))
  }
  const summary = Object.keys(map)
    .sort((a, b) => map[a].addedAt - map[b].addedAt)
    .map((sid) => {
      const w = map[sid]
      return {
        sid: w.sid,
        agent: w.agent,
        addedAt: w.addedAt,
        lastEventType: w.lastEventType,
        pendingGrace: !!(w.pending && w.pending.length),
      }
    })
  await update($, fleetSummaryAtom, () => summary)
  return map
}

async function addWatchesFromSummon($, instanceId, discovered) {
  if (!discovered.length) return
  const map = await loadWatches($, instanceId)
  const now = await $.clock.now()
  for (const d of discovered) {
    if (map[d.sid]) continue
    if (Object.keys(map).length >= MAX_WATCHES) {
      safeLog($, 'watch cap (' + MAX_WATCHES + ') reached, dropping sid=' + d.sid)
      continue
    }
    const watch = { sid: d.sid, agent: d.agent, outbox: d.outbox, lastSeq: 0, addedAt: now }
    await saveWatch($, instanceId, watch)
    map[d.sid] = watch
  }
  await syncState($, instanceId)
}

async function pollOnce($, instanceId, runsRoot) {
  try {
    const map = await loadWatches($, instanceId)
    const now = await $.clock.now()
    const wakes = []
    for (const sid of Object.keys(map)) {
      const w = map[sid]
      if (now - w.addedAt > STALE_MS) {
        await dropWatchAndWoke($, instanceId, sid)
        delete map[sid]
        continue
      }
      if (!isUnderRunsRoot(w.outbox, runsRoot)) {
        safeLog($, 'refusing to read outbox outside runs root: ' + w.outbox)
        continue
      }
      let stat = null
      try {
        stat = await $.fs.stat(w.outbox)
      } catch (err) {
        safeLog($, 'stat failed for ' + w.outbox + ': ' + (err && err.message))
        stat = null
      }
      const pending = Array.isArray(w.pending) ? w.pending : []
      let newEvents = []
      if (shouldRead(w.lastStat, stat)) {
        let content
        try {
          content = await $.fs.read(w.outbox, { as: 'text' })
        } catch (err) {
          safeLog($, 'read failed for ' + w.outbox + ': ' + (err && err.message))
          content = null
        }
        if (content !== null) {
          const parsed = parseOutboxLines(content, w.lastSeq)
          newEvents = parsed.events
          w.lastSeq = parsed.lastSeq
          if (stat) w.lastStat = { size: stat.size, mtimeMs: stat.mtimeMs }
        }
      }
      const toEvaluate = pending.concat(newEvents)
      if (!toEvaluate.length) {
        w.pending = []
        await saveWatch($, instanceId, w)
        continue
      }

      const synthesized = await readSynthesizedSeqs($, runsRoot, sid)
      let dropSid = false
      const stillPending = []
      for (const msg of toEvaluate) {
        const decision = evaluateTerminalEvent(msg, now, synthesized)
        if (decision.action === 'wait') {
          stillPending.push(msg)
          continue
        }
        w.lastEventType = msg.type
        if (decision.action === 'drop-silent') {
          dropSid = true
          continue
        }
        const dedupeKey = 'woke:' + sid + ':' + msg.seq
        const already = await $.store.get(dedupeKey)
        if (already) continue
        await $.store.set(dedupeKey, { ts: now })
        wakes.push({ sid, agent: w.agent, outbox: w.outbox, msg })
        if (decision.terminal) dropSid = true
      }
      w.pending = stillPending
      if (dropSid) {
        await dropWatchAndWoke($, instanceId, sid)
        delete map[sid]
      } else {
        await saveWatch($, instanceId, w)
      }
    }
    await syncState($, instanceId)
    if (wakes.length) {
      const text = buildWakeText(wakes)
      // Not awaited (submit resolves once a new turn starts, which must not
      // block this tick) - but still must never surface as an unhandled
      // rejection, so the fire-and-forget call gets its own .catch.
      Promise.resolve()
        .then(() => $.prompt.submit({ text }))
        .catch((err) => safeLog($, 'prompt.submit failed: ' + (err && err.message)))
    }
  } catch (err) {
    safeLog($, 'pollOnce failed: ' + (err && err.message))
  }
}

function startTimer($, instanceId, runsRoot) {
  try {
    if (timer) timer.cancel()
    timer = $.clock.every(POLL_MS, () => pollOnce($, instanceId, runsRoot))
  } catch (err) {
    safeLog($, 'startTimer failed: ' + (err && err.message))
  }
}

async function onBoot($, cwd) {
  try {
    const advisorSid = await $.env.get('ADVISOR_SID')
    if (isWorkerSession(cwd, advisorSid)) return
    const instanceId = await resolveInstanceId($)
    const runsRoot = await resolveRunsRoot($)
    await pruneStaleKeys($)
    await syncState($, instanceId)
    startTimer($, instanceId, runsRoot)
  } catch (err) {
    safeLog($, 'onBoot failed: ' + (err && err.message))
  }
}

// Test-only: simulates what /clear does to $.state (module vars, unlike
// $.state, are untouched by /clear - only a real reload clears them).
export async function __simulateClear($) {
  await update($, instanceIdAtom, () => '')
}

// Test-only: undoes what a real module reload does to module-level state.
export function __simulateReload() {
  if (timer) {
    try {
      timer.cancel()
    } catch {
      // already cancelled or invalid
    }
    timer = null
  }
  moduleInstanceId = null
  moduleRunsRoot = null
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const base = await next(e)
    try {
      const summary = await read($, fleetSummaryAtom)
      if (!summary || !summary.length) return base
      const now = await $.clock.now()
      const lines = formatFleetLines(summary, now)
      if (!lines.length) return base
      const ownBox = {
        type: 'Box',
        props: { flexDirection: 'column' },
        children: lines.map((l) => ({ type: 'Text', props: {}, children: [l] })),
      }
      return { type: 'Box', props: { flexDirection: 'column' }, children: [base, ownBox] }
    } catch (err) {
      safeLog($, 'ui.render AbovePrompt failed: ' + (err && err.message))
      return base
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const callStart = Math.floor((await $.clock.now()) / 1000)
    const result = await next(e)
    try {
      const cwd = await $.session.cwd()
      const advisorSid = await $.env.get('ADVISOR_SID')
      if (isWorkerSession(cwd, advisorSid)) return result
      if (!isSummonCommand(e && e.command)) return result
      const callEnd = Math.ceil((await $.clock.now()) / 1000)
      const instanceId = await resolveInstanceId($)
      const runsRoot = await resolveRunsRoot($)

      const viaList = await discoverViaFsList($, runsRoot, callStart, callEnd)
      const viaStdout = parseSummonOutput(extractResultText(result))
      const discovered = viaList.slice()
      for (const d of viaStdout) {
        if (!discovered.some((x) => x.sid === d.sid)) discovered.push(d)
      }

      if (discovered.length) {
        await addWatchesFromSummon($, instanceId, discovered)
      }
    } catch (err) {
      safeLog($, 'tool.call watch-discovery failed: ' + (err && err.message))
    }
    return result
  })
}
