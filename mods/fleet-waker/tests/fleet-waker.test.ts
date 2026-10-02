import { expect, test, mock } from 'claude-code/testing'
import {
  isWorkerSession,
  isSummonCommand,
  isUnderRunsRoot,
  isStrictSidDir,
  sidEpoch,
  inEpochWindow,
  extractResultText,
  parseSummonOutput,
  parseEnvelope,
  parseOutboxLines,
  parseSynthesisLog,
  evaluateTerminalEvent,
  buildWakeText,
  discoverViaFsList,
  __simulateReload,
} from '../hooks/register.js'

const RUNS_ROOT = '/h/.advisor/runs'

// ─── Pure functions ─────────────────────────────────────────────────────

test('isWorkerSession: true under .advisor/runs/<sid>/workspace and .advisor/slots/<name>, false elsewhere', () => {
  expect(isWorkerSession('/Users/x/.advisor/runs/abc-123/workspace')).toBe(true)
  expect(isWorkerSession('/Users/x/.advisor/runs/abc-123/workspace/sub')).toBe(true)
  expect(isWorkerSession('/Users/x/.advisor/slots/coder-1')).toBe(true)
  expect(isWorkerSession('/Users/x/projects/myrepo')).toBe(false)
  expect(isWorkerSession(undefined)).toBe(false)
})

test('isWorkerSession: ADVISOR_SID signal alone, cwd signal alone, neither', () => {
  expect(isWorkerSession('/Users/x/projects/myrepo', '1790932045-ed0c73')).toBe(true)
  expect(isWorkerSession('/Users/x/.advisor/runs/abc-123/workspace', undefined)).toBe(true)
  expect(isWorkerSession('/Users/x/projects/myrepo', undefined)).toBe(false)
  expect(isWorkerSession('/Users/x/projects/myrepo', '')).toBe(false)
})

test('isSummonCommand: matches a bin/summon invocation, excludes --help/-h', () => {
  expect(isSummonCommand('bin/summon --agent coder --task "x" --goal "y"')).toBe(true)
  expect(isSummonCommand('bin/summon --help')).toBe(false)
  expect(isSummonCommand('bin/summon -h')).toBe(false)
  expect(isSummonCommand('git status')).toBe(false)
  expect(isSummonCommand(undefined)).toBe(false)
})

test('isUnderRunsRoot: accepts a path under the given runsRoot, rejects traversal, sibling-prefix and foreign roots', () => {
  const root = '/tmp/x/runs'
  expect(isUnderRunsRoot('/tmp/x/runs/123-abc/channel/outbox.jsonl', root)).toBe(true)
  expect(isUnderRunsRoot('/tmp/x/runs/123-abc/../../../etc/passwd', root)).toBe(false)
  expect(isUnderRunsRoot('/tmp/x/runs-evil/123-abc/channel/outbox.jsonl', root)).toBe(false)
  expect(isUnderRunsRoot('/tmp/outbox.jsonl', root)).toBe(false)
  expect(isUnderRunsRoot('/tmp/x/runs/123-abc/channel/outbox.jsonl', '')).toBe(false)
  expect(isUnderRunsRoot(undefined, root)).toBe(false)
  const home = '/Users/x/.advisor/runs'
  expect(isUnderRunsRoot(home + '/sid1/channel/outbox.jsonl', root)).toBe(false)
})

test('isStrictSidDir: accepts a real sid, rejects siblings and case aliases', () => {
  expect(isStrictSidDir('1790932045-ed0c73')).toBe(true)
  expect(isStrictSidDir('plans')).toBe(false)
  expect(isStrictSidDir('researcher-1')).toBe(false)
  expect(isStrictSidDir('staging-sambla-design')).toBe(false)
  expect(isStrictSidDir('1790932045-ED0C73')).toBe(false)
})

test('sidEpoch + inEpochWindow: includes [callStart-2, callEnd+2], excludes outside it', () => {
  expect(sidEpoch('1790932045-ed0c73')).toBe(1790932045)
  expect(inEpochWindow(1000, 998, 1010)).toBe(true)
  expect(inEpochWindow(998, 998, 1010)).toBe(true)
  expect(inEpochWindow(1012, 998, 1010)).toBe(true)
  expect(inEpochWindow(995, 998, 1010)).toBe(false)
  expect(inEpochWindow(1013, 998, 1010)).toBe(false)
})

test('extractResultText: prefers ToolCallResult.result.stdout, then result/stdout/output, falls back to raw string or JSON', () => {
  expect(extractResultText('plain stdout')).toBe('plain stdout')
  expect(extractResultText({ result: { stdout: 'from ToolCallResult.result.stdout' } })).toBe(
    'from ToolCallResult.result.stdout',
  )
  expect(extractResultText({ result: 'from result' })).toBe('from result')
  expect(extractResultText({ stdout: 'from stdout' })).toBe('from stdout')
  expect(extractResultText({ output: 'from output' })).toBe('from output')
  expect(extractResultText({ other: 1 })).toBe(JSON.stringify({ other: 1 }))
})

test('parseSummonOutput: finds a solo {sid, outbox} object among noise lines', () => {
  const text =
    'http://127.0.0.1:7878/session/abc\n' +
    '{"sid":"abc","agent":"coder","outbox":"/h/.advisor/runs/abc/channel/outbox.jsonl","outputDir":"/h/.advisor/runs/abc/output"}\n'
  expect(parseSummonOutput(text)).toEqual([
    { sid: 'abc', agent: 'coder', outbox: '/h/.advisor/runs/abc/channel/outbox.jsonl' },
  ])
})

test('parseSummonOutput: finds every entry under an ensemble .sessions[] array', () => {
  const text = JSON.stringify({
    sessions: [
      { sid: 's1', agent: 'coder', outbox: '/h/.advisor/runs/s1/channel/outbox.jsonl' },
      { sid: 's2', agent: 'coder', outbox: '/h/.advisor/runs/s2/channel/outbox.jsonl' },
    ],
  })
  expect(parseSummonOutput(text)).toEqual([
    { sid: 's1', agent: 'coder', outbox: '/h/.advisor/runs/s1/channel/outbox.jsonl' },
    { sid: 's2', agent: 'coder', outbox: '/h/.advisor/runs/s2/channel/outbox.jsonl' },
  ])
})

test('parseSummonOutput: parses a real pretty-printed (multi-line, 2-space indent) bin/summon blob', () => {
  const meta = {
    sid: '1790932045-ed0c73',
    agent: 'coder',
    outbox: '/h/.advisor/runs/1790932045-ed0c73/channel/outbox.jsonl',
    outputDir: '/h/.advisor/runs/1790932045-ed0c73/output',
  }
  const text = JSON.stringify(meta, null, 2) + '\n'
  expect(parseSummonOutput(text)).toEqual([{ sid: meta.sid, agent: 'coder', outbox: meta.outbox }])
})

test('parseSummonOutput: ignores non-JSON lines and objects missing sid/outbox', () => {
  expect(parseSummonOutput('not json\n{"sid":"a"}\n{"outbox":"/x"}\n')).toEqual([])
})

test('parseEnvelope: decodes a JSON-string body, passes an object body through, rejects plain prose', () => {
  expect(parseEnvelope('{"summary":"ok","verdict":"complete"}')).toEqual({ summary: 'ok', verdict: 'complete' })
  expect(parseEnvelope({ summary: 'ok' })).toEqual({ summary: 'ok' })
  expect(parseEnvelope('plain text')).toBeNull()
})

test('parseOutboxLines: picks up result/error/question past lastSeq, skips malformed and progress lines', () => {
  const content =
    [
      '{"seq":1,"type":"progress","body":"go"}',
      'not json at all',
      '{"seq":2,"type":"result","body":{"summary":"done","verdict":"complete"}}',
      '{"seq":3,"type":"question","body":"need input"}',
    ].join('\n') + '\n'
  const { events, lastSeq } = parseOutboxLines(content, 0)
  expect(lastSeq).toBe(3)
  expect(events.map((e) => e.seq)).toEqual([2, 3])
})

test('parseOutboxLines: the lastSeq gate skips already-seen lines on a later call', () => {
  const content = '{"seq":1,"type":"result","body":"x"}\n{"seq":2,"type":"result","body":"y"}\n'
  const { events, lastSeq } = parseOutboxLines(content, 1)
  expect(lastSeq).toBe(2)
  expect(events.map((e) => e.seq)).toEqual([2])
})

test('parseSynthesisLog: collects seq numbers from well-formed JSONL records, skips malformed lines', () => {
  const content = '{"seq":2,"sid":"s1","established":"x"}\nnot json\n{"seq":5,"sid":"s1"}\n'
  const seqs = parseSynthesisLog(content)
  expect(seqs.has(2)).toBe(true)
  expect(seqs.has(5)).toBe(true)
  expect(seqs.has(3)).toBe(false)
})

test('evaluateTerminalEvent: fresh waits; grace-old unsynthesized considers waking; grace-old synthesized drops silently', () => {
  const now = 1000000000
  const fresh = { type: 'result', seq: 2, ts: now / 1000 }
  const old = { type: 'result', seq: 2, ts: (now - 31000) / 1000 }
  expect(evaluateTerminalEvent(fresh, now, new Set())).toEqual({ action: 'wait' })
  expect(evaluateTerminalEvent(old, now, new Set())).toEqual({ action: 'consider-wake', terminal: true })
  expect(evaluateTerminalEvent(old, now, new Set([2]))).toEqual({ action: 'drop-silent' })
  // A question is never synthesized (the log only records result/error seqs), so it only ever waits or wakes.
  const oldQuestion = { type: 'question', seq: 9, ts: (now - 31000) / 1000 }
  expect(evaluateTerminalEvent(oldQuestion, now, new Set([9]))).toEqual({ action: 'consider-wake', terminal: false })
})

test('buildWakeText: names every sid/agent/type/seq/verdict/summary, truncates summary to 200 chars', () => {
  const longSummary = 'x'.repeat(250)
  const text = buildWakeText([
    { sid: 's1', agent: 'coder', outbox: '/o1', msg: { seq: 5, type: 'result', body: { summary: 'short one', verdict: 'complete' } } },
    { sid: 's2', agent: 'planner', outbox: '/o2', msg: { seq: 9, type: 'result', body: { summary: longSummary, verdict: 'partial' } } },
  ])
  expect(text).toContain('sid=s1')
  expect(text).toContain('sid=s2')
  expect(text).toContain('verdict=complete')
  expect(text).toContain('verdict=partial')
  expect(text).toContain('Synthesize per Step 7 before any other action.')
  expect(text).not.toContain('x'.repeat(201))
})

test('discoverViaFsList: strict-sid + epoch-window filtering, with a meta.json agent lookup, via a hand-rolled $ (no kit)', async () => {
  const root = '/h/.advisor/runs'
  const fake$ = {
    fs: {
      list: async (path: string) =>
        path === root
          ? [
              { name: '1000000000-abc123', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
              { name: '1000000900-def456', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, // outside the window
              { name: 'plans', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, // rejected sibling
              { name: '1000000005-notadir', kind: 'file', size: 0, mtimeMs: 0, isLink: false }, // not a dir
            ]
          : [],
      read: async (path: string) => {
        if (path === root + '/1000000000-abc123/meta.json') return JSON.stringify({ sid: '1000000000-abc123', agent: 'coder' })
        throw new Error('ENOENT: ' + path)
      },
    },
  }
  const found = await discoverViaFsList(fake$, root, 999999999, 1000000002)
  expect(found).toEqual([
    { sid: '1000000000-abc123', agent: 'coder', outbox: root + '/1000000000-abc123/channel/outbox.jsonl' },
  ])
})

test('discoverViaFsList: a missing meta.json still yields a watch, with agent "unknown"', async () => {
  const root = '/h/.advisor/runs'
  const fake$ = {
    fs: {
      list: async () => [{ name: '1000000000-abc123', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
      read: async () => {
        throw new Error('ENOENT')
      },
    },
  }
  const found = await discoverViaFsList(fake$, root, 999999999, 1000000002)
  expect(found).toEqual([
    { sid: '1000000000-abc123', agent: 'unknown', outbox: root + '/1000000000-abc123/channel/outbox.jsonl' },
  ])
})

// ─── Engine-driven (live) ───────────────────────────────────────────────
//
// The host statically scans each `on(event, handler)` call site: a handler
// may only call the `$.*` methods the scan can see written literally at that
// call site, so every stub below is inlined (never passed in via a variable)
// and none of them needs to read the live clock - "old enough" events use a
// fixed far-past `ts`, which is grace-old under any clock baseline. All
// `on(...)` registration happens before the test's first `$` call (a host
// rule: hooks are wired before the plugin's own module can run).

function wireCommon(on, store, cwd) {
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
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', () => ({ cwd }))
  on('env.get', ($, e) => ({ value: e.name === 'ADVISOR_RUNS_ROOT' ? RUNS_ROOT : undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
}

test('a Bash call running bin/summon adds a watch from the discovered sid/outbox (stdout path)', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  mock.clock(on)

  const outbox = RUNS_ROOT + '/worker-1/channel/outbox.jsonl'
  const summonJson = JSON.stringify({ sid: 'worker-1', agent: 'coder', outbox, outputDir: RUNS_ROOT + '/worker-1/output' })
  on('tool.call', () => ({ result: { stdout: summonJson + '\n' } }))

  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "x" --goal "y"' })

  const key = Array.from(store.keys()).find((k) => k.startsWith('watch:') && k.endsWith(':worker-1'))
  expect(store.get(key)).toMatchObject({ sid: 'worker-1', agent: 'coder', outbox, lastSeq: 0 })
})

test('a non-summon Bash call and a bin/summon --help call add no watch', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  mock.clock(on)
  on('tool.call', () => ({
    result: { stdout: JSON.stringify({ sid: 'w', agent: 'coder', outbox: RUNS_ROOT + '/w/channel/outbox.jsonl' }) },
  }))

  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --help' })

  expect(Array.from(store.keys()).filter((k) => k.startsWith('watch:'))).toEqual([])
})

test('a poll tick wakes exactly once on a (fixed, grace-old) terminal result, and never wakes again for it', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  on('ui.status', () => ({ value: undefined }))
  const outbox = RUNS_ROOT + '/worker-1/channel/outbox.jsonl'
  on('fs.read', ($, e) =>
    e.path === outbox
      ? {
          value:
            '{"seq":1,"type":"progress","body":"starting"}\n' +
            '{"seq":2,"type":"result","body":{"summary":"done","verdict":"complete"},"ts":-1000000000}\n',
        }
      : { value: '' },
  )
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: { stdout: JSON.stringify({ sid: 'worker-1', agent: 'coder', outbox }) } }))
  const submits: string[] = []
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "x" --goal "y"' })

  await clock.advance(5000)
  expect(submits.length).toBe(1)
  expect(submits[0]).toContain('sid=worker-1')
  expect(submits[0]).toContain('verdict=complete')

  // Watch already dropped on the result - a later tick must not wake again.
  await clock.advance(5000)
  expect(submits.length).toBe(1)
})

test('a (fixed, grace-old) result that is already synthesized is dropped silently, without waking, and its woke keys are swept', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  on('ui.status', () => ({ value: undefined }))
  const outbox = RUNS_ROOT + '/worker-2/channel/outbox.jsonl'
  const synthPath = RUNS_ROOT + '/worker-2/synthesis.log'
  on('fs.read', ($, e) => {
    if (e.path === outbox) {
      return { value: '{"seq":7,"type":"result","body":{"summary":"done","verdict":"complete"},"ts":-1000000000}\n' }
    }
    if (e.path === synthPath) {
      return { value: '{"seq":7,"sid":"worker-2","established":"x","gap":"none"}\n' }
    }
    return { value: '' }
  })
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: { stdout: JSON.stringify({ sid: 'worker-2', agent: 'coder', outbox }) } }))
  const submits: string[] = []
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "a" --goal "b"' })
  store.set('woke:worker-2:7', { ts: 0 })

  await clock.advance(5000)

  expect(submits.length).toBe(0)
  expect(Array.from(store.keys()).filter((k) => k.startsWith('watch:') && k.endsWith(':worker-2'))).toEqual([])
  expect(store.has('woke:worker-2:7')).toBe(false)
})

test('two workers finishing (fixed, grace-old) in the same tick produce a single submit naming both', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  on('ui.status', () => ({ value: undefined }))
  const outboxes = { w1: RUNS_ROOT + '/w1/channel/outbox.jsonl', w2: RUNS_ROOT + '/w2/channel/outbox.jsonl' }
  on('fs.read', ($, e) => {
    if (e.path === outboxes.w1) return { value: '{"seq":1,"type":"result","body":{"summary":"w1 done","verdict":"complete"},"ts":-1000000000}\n' }
    if (e.path === outboxes.w2) return { value: '{"seq":1,"type":"result","body":{"summary":"w2 done","verdict":"complete"},"ts":-1000000000}\n' }
    return { value: '' }
  })
  const clock = mock.clock(on)
  const summons = [
    { sid: 'w1', agent: 'coder', outbox: outboxes.w1 },
    { sid: 'w2', agent: 'coder', outbox: outboxes.w2 },
  ]
  let call = 0
  on('tool.call', () => ({ result: { stdout: JSON.stringify(summons[call++]) } }))
  const submits: string[] = []
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "a" --goal "b"' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "c" --goal "d"' })

  await clock.advance(5000)

  expect(submits.length).toBe(1)
  expect(submits[0]).toContain('sid=w1')
  expect(submits[0]).toContain('sid=w2')
})

test('boot with zero watches clears the status line with undefined, not an empty string', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  const statusArgs: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statusArgs.push(e.text)
    return { value: undefined }
  })
  mock.clock(on)

  await $.session.start({ cwd: '/Users/x/project' })

  expect(statusArgs.length).toBeGreaterThan(0)
  expect(statusArgs[statusArgs.length - 1]).toBeUndefined()
})

test('a worker-cwd session registers no timer, status, or watch', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/.advisor/runs/worker-session/workspace')
  const statuses: string[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const submits: string[] = []
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/Users/x/.advisor/runs/worker-session/workspace' })
  await clock.advance(60000)

  expect(statuses).toEqual([])
  expect(submits).toEqual([])
  expect(Array.from(store.keys()).filter((k) => k.startsWith('watch:'))).toEqual([])
})

test('classic.SessionStart restores a stored watch and resumes polling (fixed, grace-old result) after a reload', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  const statuses: string[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('classic.SessionStart', ($, e) => ({ value: e }))
  const outbox = RUNS_ROOT + '/worker-1/channel/outbox.jsonl'
  on('fs.read', ($, e) =>
    e.path === outbox
      ? { value: '{"seq":1,"type":"result","body":{"summary":"done","verdict":"complete"},"ts":-1000000000}\n' }
      : { value: '' },
  )
  on('tool.call', () => ({ result: { stdout: JSON.stringify({ sid: 'worker-1', agent: 'coder', outbox }) } }))
  const submits: string[] = []
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on)

  // Phase 1: boot and register a watch for real (establishes this session's instanceId in $.state).
  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "x" --goal "y"' })
  expect(statuses).toContain('fleet: 1 in flight')

  // Phase 2: simulate a reload - module vars (timer, instanceId, runsRoot) reset;
  // the instanceId is re-read from $.state, which survives the reload.
  __simulateReload()
  statuses.length = 0

  await $.classic.SessionStart({ source: 'resume', cwd: '/Users/x/project' })
  expect(statuses).toContain('fleet: 1 in flight')

  await clock.advance(5000)
  expect(submits.length).toBe(1)
  expect(submits[0]).toContain('sid=worker-1')
})

test('instance id survives a reload: a fresh summon call afterward reuses the same watch key prefix', async ($, on) => {
  const store = new Map()
  wireCommon(on, store, '/Users/x/project')
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '' }))
  on('classic.SessionStart', ($, e) => ({ value: e }))
  mock.clock(on)

  const outbox9 = RUNS_ROOT + '/worker-9/channel/outbox.jsonl'
  const outbox10 = RUNS_ROOT + '/worker-10/channel/outbox.jsonl'
  let call = 0
  const summons = [
    { sid: 'worker-9', agent: 'coder', outbox: outbox9 },
    { sid: 'worker-10', agent: 'coder', outbox: outbox10 },
  ]
  on('tool.call', () => ({ result: { stdout: JSON.stringify(summons[call++]) } }))

  await $.session.start({ cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "x" --goal "y"' })
  const key1 = Array.from(store.keys()).find((k) => k.startsWith('watch:') && k.endsWith(':worker-9'))
  expect(key1).toBeDefined()

  __simulateReload()
  await $.classic.SessionStart({ source: 'resume', cwd: '/Users/x/project' })
  await $.tool.call({ tool: 'Bash', command: 'bin/summon --agent coder --task "p" --goal "q"' })
  const key2 = Array.from(store.keys()).find((k) => k.startsWith('watch:') && k.endsWith(':worker-10'))
  expect(key2).toBeDefined()

  expect((key2 as string).slice(0, (key2 as string).lastIndexOf(':'))).toBe((key1 as string).slice(0, (key1 as string).lastIndexOf(':')))
})
