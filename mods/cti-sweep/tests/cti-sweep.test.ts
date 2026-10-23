import { expect, test } from 'claude-code/testing'
import {
  isWorkerSession,
  gateSweep,
  modeFromPermissions,
  mergeReport,
  clockLabel,
  localDateKey,
  isStaleRunning,
  decideClaim,
  lockPath,
  lookbackHours,
  sanitizeText,
  parseWatchlist,
  matchesWatchlist,
  parseAgentAnswer,
  isAlert,
  selectAlerts,
  pruneSeen,
  markSeen,
  recentSeenIds,
  parseSources,
  nvdTime,
  fillSourceUrls,
  buildPrompt,
  buildNotification,
  buildOsascriptArgv,
  buildReport,
} from '../hooks/register.js'

const HOUR = 3600000
const NOW = new Date(2026, 9, 23, 9, 30).getTime()

function finding(over: Record<string, unknown> = {}) {
  return {
    id: 'CVE-2026-1234',
    title: 'Example flaw',
    category: 'vulnerability',
    severity: 'medium',
    products: ['Example'],
    summary: 'A flaw.',
    action: 'Patch.',
    sources: ['https://example.com/advisory'],
    exploited: false,
    ...over,
  }
}

function answerWith(obj: unknown) {
  return 'Overview text.\n\n```json\n' + JSON.stringify(obj) + '\n```\n'
}

// ─── Gating ────────────────────────────────────────────────────────────

test('isWorkerSession: advisor run workspace, slot, ADVISOR_SID; not a normal repo', () => {
  expect(isWorkerSession('/Users/x/.advisor/runs/123-abc/workspace')).toBe(true)
  expect(isWorkerSession('/Users/x/.advisor/runs/123-abc/workspace/mods')).toBe(true)
  expect(isWorkerSession('/Users/x/.advisor/slots/coder-1')).toBe(true)
  expect(isWorkerSession('/Users/x/projects/app', '123-abc')).toBe(true)
  expect(isWorkerSession('/Users/x/projects/app', '')).toBe(false)
  expect(isWorkerSession('/Users/x/projects/app')).toBe(false)
  expect(isWorkerSession(undefined)).toBe(false)
})

test('gateSweep: only an interactive, non-worker, non-disabled session passes', () => {
  const base = { cwd: '/Users/x/projects/app', advisorSid: undefined, isInteractive: true, surface: 'terminal', disable: undefined, mode: 'auto' }
  expect(gateSweep(base)).toEqual({ ok: true })
  expect(gateSweep({ ...base, cwd: '/Users/x/.advisor/runs/1-a/workspace' })).toEqual({ ok: false, reason: 'worker' })
  expect(gateSweep({ ...base, advisorSid: '1-a' })).toEqual({ ok: false, reason: 'worker' })
  expect(gateSweep({ ...base, isInteractive: false, surface: null })).toEqual({ ok: false, reason: 'headless' })
  expect(gateSweep({ ...base, surface: null })).toEqual({ ok: false, reason: 'headless' })
  expect(gateSweep({ ...base, disable: '1' })).toEqual({ ok: false, reason: 'disabled' })
  expect(gateSweep({ ...base, disable: '0' })).toEqual({ ok: true })
})

// ─── Day claim ─────────────────────────────────────────────────────────

test('localDateKey uses the local calendar date, zero-padded', () => {
  expect(localDateKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
  expect(localDateKey(new Date(2026, 9, 23, 0, 1).getTime())).toBe('2026-10-23')
})

test('isStaleRunning: running older than 2h is stale; younger or other status is not', () => {
  expect(isStaleRunning({ status: 'running', startedAt: NOW - 2 * HOUR - 1, attempts: 1 }, NOW)).toBe(true)
  expect(isStaleRunning({ status: 'running', startedAt: NOW - HOUR, attempts: 1 }, NOW)).toBe(false)
  expect(isStaleRunning({ status: 'failed', startedAt: NOW - 5 * HOUR, attempts: 1 }, NOW)).toBe(false)
  expect(isStaleRunning(undefined, NOW)).toBe(false)
})

test('decideClaim: fresh day, done, running, stale, failed retries, max attempts, force', () => {
  expect(decideClaim(undefined, NOW, false)).toEqual({ ok: true, attempt: 1 })
  expect(decideClaim({ status: 'done', startedAt: NOW - HOUR, attempts: 1 }, NOW, false)).toEqual({ ok: false, reason: 'done' })
  expect(decideClaim({ status: 'running', startedAt: NOW - HOUR, attempts: 1 }, NOW, false)).toEqual({ ok: false, reason: 'running' })
  expect(decideClaim({ status: 'running', startedAt: NOW - HOUR, attempts: 1 }, NOW, true)).toEqual({ ok: false, reason: 'running' })
  expect(decideClaim({ status: 'running', startedAt: NOW - 3 * HOUR, attempts: 1 }, NOW, false)).toEqual({ ok: true, attempt: 2 })
  expect(decideClaim({ status: 'failed', startedAt: NOW - HOUR, attempts: 1 }, NOW, false)).toEqual({ ok: true, attempt: 2 })
  expect(decideClaim({ status: 'failed', startedAt: NOW - HOUR, attempts: 2 }, NOW, false)).toEqual({ ok: false, reason: 'max-attempts' })
  expect(decideClaim({ status: 'done', startedAt: NOW - HOUR, attempts: 2 }, NOW, true)).toEqual({ ok: true, attempt: 3 })
  expect(decideClaim('garbage', NOW, false)).toEqual({ ok: true, attempt: 1 })
})

test('lockPath: one lock per day and attempt; forced runs get their own', () => {
  expect(lockPath('/h/.advisor/cti', '2026-10-23', 2, false, NOW)).toBe('/h/.advisor/cti/.locks/2026-10-23-a2')
  expect(lockPath('/h/.advisor/cti', '2026-10-23', 2, true, NOW)).toBe('/h/.advisor/cti/.locks/2026-10-23-f' + NOW)
})

test('lookbackHours: 36h default, since last success, capped at 7 days', () => {
  expect(lookbackHours(undefined, NOW)).toBe(36)
  expect(lookbackHours(NOW - 10 * HOUR - 1, NOW)).toBe(11)
  expect(lookbackHours(NOW - 30 * 24 * HOUR, NOW)).toBe(168)
  expect(lookbackHours(NOW + HOUR, NOW)).toBe(36)
})

// ─── Untrusted output ──────────────────────────────────────────────────

test('sanitizeText strips ANSI, control and bidi characters, collapses whitespace, caps length', () => {
  expect(sanitizeText('\u001b[31mred\u001b[0m text', 100)).toBe('red text')
  expect(sanitizeText('a\u0000b\u0007c‮d\nnext\tline', 100)).toBe('abcd next line')
  expect(sanitizeText('\u001b]0;title\u0007ok', 100)).toBe('ok')
  expect(sanitizeText('x'.repeat(50), 10)).toBe('xxxxxxxxx…')
  expect(sanitizeText(42, 10)).toBe('')
})

test('parseAgentAnswer: takes the LAST json fence and validates each finding', () => {
  const early = '```json\n{"date":"2026-01-01","findings":[]}\n```\n'
  const text = early + answerWith({ date: '2026-10-23', findings: [finding()] })
  const parsed = parseAgentAnswer(text)
  expect(parsed.ok).toBe(true)
  expect(parsed.date).toBe('2026-10-23')
  expect(parsed.findings.length).toBe(1)
  expect(parsed.invalid).toBe(0)
})

test('parseAgentAnswer: drops invalid items and counts them', () => {
  const text = answerWith({
    date: '2026-10-23',
    findings: [
      finding(),
      finding({ id: '' }),
      finding({ severity: 'urgent' }),
      finding({ category: 'malware' }),
      finding({ sources: ['javascript:alert(1)', 'ftp://x'] }),
      finding({ exploited: 'yes' }),
      finding({ products: 'Bun' }),
      'not an object',
    ],
  })
  const parsed = parseAgentAnswer(text)
  expect(parsed.ok).toBe(true)
  expect(parsed.findings.length).toBe(1)
  expect(parsed.invalid).toBe(7)
})

test('parseAgentAnswer: keeps only http(s) sources, caps lengths, sanitizes fields', () => {
  const text = answerWith({
    date: '2026-10-23',
    findings: [
      finding({
        title: '\u001b[1mBold\u001b[0m title',
        summary: 's'.repeat(400),
        action: 'a'.repeat(300),
        sources: ['https://ok.example/a', 'file:///etc/passwd', 'http://ok.example/b c', 'HTTP://also.example/x'],
      }),
    ],
  })
  const f = parseAgentAnswer(text).findings[0]!
  expect(f.title).toBe('Bold title')
  expect(f.summary.length).toBe(300)
  expect(f.action.length).toBe(200)
  expect(f.sources).toEqual(['https://ok.example/a', 'HTTP://also.example/x'])
})

test('parseAgentAnswer: feed and API query URLs are not sources; canonical item pages are kept', () => {
  const bad = [
    'https://api.github.com/advisories?type=malware&per_page=8',
    'https://services.nvd.nist.gov/rest/json/cves/2.0?cvssV3Severity=CRITICAL',
    'https://evil@api.github.com/advisories/GHSA-x',
    'https://API.GITHUB.COM:443/advisories',
    'https://www.bleepingcomputer.com/feed/',
    'https://example.com/news/feed',
    'https://example.com/rss',
    'https://example.com/rss/',
    'https://example.com/blog/index.xml',
    'https://example.com/blog/atom.atom',
  ]
  const good = [
    'https://github.com/advisories/GHSA-673q-mjm6-r5xr',
    'https://nvd.nist.gov/vuln/detail/CVE-2026-115384',
    'https://example.com/feedback',
    'https://example.com/news/rss-explained',
    'https://example.com/feed/launch-post',
  ]
  const parsed = parseAgentAnswer(answerWith({ date: '2026-10-23', findings: [finding({ sources: [...bad, ...good] })] }))
  expect(parsed.findings[0]!.sources).toEqual(good)
  const onlyBad = parseAgentAnswer(answerWith({ date: '2026-10-23', findings: [finding({ sources: bad }), finding({ sources: [bad[0], good[0]] })] }))
  expect(onlyBad.findings.length).toBe(1)
  expect(onlyBad.findings[0]!.sources).toEqual([good[0]])
  expect(onlyBad.invalid).toBe(1)
})

test('parseAgentAnswer: no fence, bad JSON, missing findings array all fail cleanly', () => {
  expect(parseAgentAnswer('no json here').ok).toBe(false)
  expect(parseAgentAnswer('```json\n{not json\n```').ok).toBe(false)
  expect(parseAgentAnswer('```json\n{"date":"2026-10-23"}\n```').ok).toBe(false)
  expect(parseAgentAnswer(undefined).ok).toBe(false)
})

// ─── Alert filter ──────────────────────────────────────────────────────

test('matchesWatchlist: whole-token, case-insensitive; Bun does not match Bunny', () => {
  const wl = parseWatchlist('Node.js, Bun, Claude Code, TiDB Cloud, ,')
  expect(wl).toEqual(['Node.js', 'Bun', 'Claude Code', 'TiDB Cloud'])
  expect(matchesWatchlist(finding({ products: ['bun'] }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ products: ['Bunny CDN'] }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ title: 'Flaw in node.js http parser' }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ title: 'Flaw in nodexjs' }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ title: 'claude code extension RCE' }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ title: 'Claude Codex' }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ products: ['tidb cloud'] }), wl)).toBe(true)
})

test('matchesWatchlist: Next.js is a whole token (dot included); next inside other words is not', () => {
  const wl = parseWatchlist('Next.js, React')
  expect(matchesWatchlist(finding({ title: 'Next.js unauthenticated RCE in `use cache`' }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ products: ['next.js'] }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ title: 'Patch released for Next.js.' }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ title: 'Nextcloud server flaw' }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ title: 'Next generation firewall bug' }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ products: ['nextjs'] }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ title: 'Next.jsx plugin' }), wl)).toBe(false)
  expect(matchesWatchlist(finding({ products: ['React'] }), wl)).toBe(true)
  expect(matchesWatchlist(finding({ title: 'Reactor core library' }), wl)).toBe(false)
})

test('isAlert: watchlist at any severity, or exploited critical; never an already-seen id', () => {
  const wl = ['Bun']
  const seen = { 'CVE-OLD': NOW }
  expect(isAlert(finding({ severity: 'critical', exploited: true }), wl, {})).toBe(true)
  expect(isAlert(finding({ severity: 'critical', exploited: false }), wl, {})).toBe(false)
  expect(isAlert(finding({ severity: 'high', exploited: true }), wl, {})).toBe(false)
  expect(isAlert(finding({ severity: 'medium', exploited: true }), wl, {})).toBe(false)
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    expect(isAlert(finding({ severity, products: ['Bun'] }), wl, {})).toBe(true)
  }
  expect(isAlert(finding({ id: 'CVE-OLD', severity: 'critical', exploited: true }), wl, seen)).toBe(false)
  expect(isAlert(finding({ id: 'CVE-OLD', products: ['Bun'] }), wl, seen)).toBe(false)
})

test('selectAlerts: watchlist matches first by severity, then exploited-critical off the watchlist', () => {
  const alerts = selectAlerts(
    [
      finding({ id: 'x1', severity: 'critical', exploited: true }),
      finding({ id: 'w-low', severity: 'low', products: ['Bun'] }),
      finding({ id: 'w-high', severity: 'high', products: ['Bun'] }),
      finding({ id: 'quiet', severity: 'high', exploited: true }),
      finding({ id: 'w-crit', severity: 'critical', products: ['Bun'] }),
      finding({ id: 'w-med', severity: 'medium', exploited: true, products: ['Bun'] }),
      finding({ id: 'x2', severity: 'critical', exploited: true }),
    ],
    ['Bun'],
    {},
  )
  expect(alerts.map((f: { id: string }) => f.id)).toEqual(['w-crit', 'w-high', 'w-med', 'w-low', 'x1', 'x2'])
})

// Modeled on the 2026-10-23 live report: 11 findings, v1 alerted 10 of them.
const LIVE_WATCHLIST = parseWatchlist(
  'Node.js, Bun, npm, LiteLLM, Claude Code, Anthropic, macOS, Chrome, Docker, GitHub, GitLab, Vercel, Railway, Zeabur, TiDB Cloud, Slack, Atlassian, Jira, Confluence, Figma, Statsig, Sentry, Postman, Homebrew, PyPI, NGINX, WordPress, OpenSSL, OpenSSH, Signal, Tor, Plex, OVHcloud, Bullhorn, Onamae, AOMEI, Next.js, React',
)

function liveReport() {
  const row = (id: string, title: string, severity: string, exploited: boolean, products: string[]) =>
    finding({ id, title, severity, exploited, products })
  return [
    row('litellm', 'LiteLLM 1.107.0 PyPI wheels and Docker images backdoored with infostealer/RAT', 'critical', true, ['LiteLLM', 'PyPI', 'Docker', 'GHCR']),
    row('plex2shell', 'Plex2Shell chain (CVE-2026-96652/96654/96655/96656) exploited in the wild; in CISA KEV', 'critical', true, ['Plex Media Server']),
    row('arista', 'Arista patches new VeloCloud Orchestrator (VCO On-Prem) zero-day exploited in attacks', 'critical', true, ['Arista VeloCloud Orchestrator']),
    row('php2shell', 'PHP2Shell: critical PHP RCE flaws CVE-2026-109618 and CVE-2026-109619', 'critical', true, ['PHP']),
    row('grabcad', 'Malicious npm packages under @grabcad and @ecg-internal scopes (critical malware advisories)', 'critical', true, ['npm', '@grabcad/*', '@ecg-internal/*']),
    row('nextjs', 'Next.js unauthenticated RCE in `use cache` and Image Optimization (SVG) (GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw)', 'critical', false, ['next']),
    row('wasmtime', 'Critical CVEs: Wasmtime and Incus (CVSS 9.9), plus TOTOLINK EX200/A950RG (10.0)', 'critical', false, ['Wasmtime', 'Incus', 'TOTOLINK EX200', 'TOTOLINK A950RG']),
    row('railway', 'Railway discloses possible unauthorized access to customer environment variables', 'high', true, ['Railway']),
    row('onamae', "Japan's Onamae Desktop Cloud hacked; malware installed on up to 26,739 customer servers", 'high', true, ['Onamae Desktop Cloud']),
    row('sentry', 'Sentry JavaScript @sentry/nextjs middleware bypass via tunnel route', 'high', false, ['@sentry/nextjs']),
    row('capcom', 'Capcom confirms breach of CAPCOM ID affecting 11.7 million accounts', 'medium', true, ['Capcom CAPCOM ID']),
  ]
}

test('live-report fixture: alerts only watchlist matches and exploited criticals, in order', () => {
  const ids = (list: Array<{ id: string }>) => list.map(f => f.id)
  const alerts = selectAlerts(liveReport(), LIVE_WATCHLIST, {})
  expect(ids(alerts)).toEqual(['litellm', 'plex2shell', 'grabcad', 'nextjs', 'railway', 'onamae', 'sentry', 'arista', 'php2shell'])
  expect(ids(alerts)).not.toContain('wasmtime')
  expect(ids(alerts)).not.toContain('capcom')
  // Without Next.js/React on the watchlist the unexploited Next.js item stays quiet.
  const noNext = selectAlerts(liveReport(), parseWatchlist('Plex, Railway'), {})
  expect(ids(noNext)).toEqual(['plex2shell', 'railway', 'litellm', 'arista', 'php2shell', 'grabcad'])
  // Already-seen ids never alert again.
  expect(ids(selectAlerts(liveReport(), LIVE_WATCHLIST, { litellm: NOW, arista: NOW })).length).toBe(7)
})

test('seen set: mark, prune after 30 days, recent ids newest first capped', () => {
  const day = 24 * HOUR
  const seen = markSeen({ old: NOW - 31 * day, keep: NOW - 29 * day }, [finding({ id: 'new' })], NOW)
  const pruned = pruneSeen(seen, NOW)
  expect(Object.keys(pruned).sort()).toEqual(['keep', 'new'])
  expect(recentSeenIds(pruned, 1)).toEqual(['new'])
  expect(pruneSeen('garbage', NOW)).toEqual({})
})

// ─── Sources & prompt ──────────────────────────────────────────────────

test('parseSources: keeps valid http(s) entries, degrades to [] on garbage', () => {
  const ok = JSON.stringify([
    { id: 'a', name: 'A', category: 'vulnerability', url: 'https://a.example', format: 'json', auth: 'none', notes: '' },
    { id: 'b', name: 'B', category: 'general', url: 'javascript:x', format: 'html', auth: 'none' },
  ])
  expect(parseSources(ok).map((s: { id: string }) => s.id)).toEqual(['a'])
  expect(parseSources('{not json')).toEqual([])
  expect(parseSources('{"a":1}')).toEqual([])
  expect(parseSources(undefined)).toEqual([])
})

test('fillSourceUrls substitutes {{since}}/{{until}} in NVD format; notes reach the prompt', () => {
  expect(nvdTime(new Date(2026, 9, 3, 7, 5, 9).getTime())).toBe('2026-10-03T07:05:09.000')
  const url = 'https://services.nvd.nist.gov/rest/json/cves/2.0?hasKev&kevStartDate={{since}}&kevEndDate={{until}}&resultsPerPage=20'
  const parsed = parseSources(JSON.stringify([{ id: 'nvd', name: 'NVD', category: 'vulnerability', url, format: 'json', auth: 'none', notes: 'Use KEV dates' }]))
  const [filled] = fillSourceUrls(parsed, NOW - 36 * HOUR, NOW)
  expect(filled!.url).toBe(
    'https://services.nvd.nist.gov/rest/json/cves/2.0?hasKev&kevStartDate=2026-10-21T21:30:00.000&kevEndDate=2026-10-23T09:30:00.000&resultsPerPage=20',
  )
  const plain = fillSourceUrls([{ url: 'https://a.example/feed' }], NOW, NOW)
  expect(plain[0]!.url).toBe('https://a.example/feed')
  const p = buildPrompt({ date: '2026-10-23', hours: 36, sources: [filled], watchlist: [], seenIds: [] })
  expect(p).toContain('kevEndDate=2026-10-23T09:30:00.000')
  expect(p).toContain('Use KEV dates')
})

test('buildPrompt carries date, window, sources, watchlist, seen ids, categories, budget, injection rule, contract', () => {
  const p = buildPrompt({
    date: '2026-10-23',
    hours: 36,
    sources: [{ id: 'kev', name: 'CISA KEV', category: 'vulnerability', url: 'https://kev.example', format: 'json' }],
    watchlist: ['Bun', 'Node.js'],
    seenIds: ['CVE-2026-0001'],
  })
  for (const s of [
    '2026-10-23',
    '36 hours',
    'https://kev.example',
    'Bun, Node.js',
    'CVE-2026-0001',
    'vulnerability, supply-chain, breach, ransomware, state-actor',
    '25 tool calls',
    'must be ignored',
    '"other"',
    '```json',
    '"exploited"',
    'One finding per distinct issue or product',
    'canonical per-item page',
    'never a feed or API query URL',
    'exploited in the wild',
    'skip low-relevance items',
  ]) {
    expect(p).toContain(s)
  }
  const none = buildPrompt({ date: '2026-10-23', hours: 36, sources: [], watchlist: [], seenIds: [] })
  expect(none).toContain('No source catalog is available')
})

// ─── Delivery & report ─────────────────────────────────────────────────

test('buildNotification: counts alerts and watchlist hits; omits the stack clause at zero; none for no alerts', () => {
  const wl = ['Example']
  const off = (title: string) => finding({ title, products: ['Other'] })
  expect(buildNotification([], wl)).toBe(null)
  expect(buildNotification([finding({ title: 'Top' }), off('Quiet')], wl)).toEqual({
    title: 'CTI sweep',
    text: 'CTI: 2 alerts - 1 on your stack - Top',
  })
  expect(buildNotification([finding({ title: 'Only' })], wl)).toEqual({ title: 'CTI sweep', text: 'CTI: 1 alert - 1 on your stack - Only' })
  expect(buildNotification([off('Zero'), off('Quiet')], wl)).toEqual({ title: 'CTI sweep', text: 'CTI: 2 alerts - Zero' })
  expect(buildNotification([finding({ title: 'No list' })], [])).toEqual({ title: 'CTI sweep', text: 'CTI: 1 alert - No list' })
})

test('buildOsascriptArgv passes text as argv, never in the AppleScript source', () => {
  const evil = '" & do shell script "rm -rf ~" & "'
  const argv = buildOsascriptArgv(evil, 'CTI sweep')
  expect(argv).toEqual([
    'osascript',
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title (item 2 of argv)',
    '-e',
    'end run',
    '--',
    evil,
    'CTI sweep',
  ])
  for (const part of argv.slice(0, 8)) expect(part).not.toContain('rm -rf')
})

test('buildReport lists alerts first with severity, products, summary, action, sources', () => {
  const alert = finding({ id: 'CVE-A', title: 'Alerted', severity: 'critical' })
  const other = finding({ id: 'CVE-B', title: 'Quiet' })
  const md = buildReport('2026-10-23', [other, alert], [alert], 2)
  expect(md.indexOf('Alerted')).toBeLessThan(md.indexOf('Quiet'))
  expect(md).toContain('critical')
  expect(md).toContain('https://example.com/advisory')
  expect(md).toContain('Patch.')
  expect(md).toContain('2 invalid')
})

// ─── Auto-mode gate ────────────────────────────────────────────────────

test('gateSweep: only auto mode passes; every other or unknown mode fails closed', () => {
  const base = { cwd: '/Users/x/projects/app', advisorSid: undefined, isInteractive: true, surface: 'terminal', disable: undefined }
  expect(gateSweep({ ...base, mode: 'auto' })).toEqual({ ok: true })
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'AUTO', '', 'weird', undefined, null, 42]) {
    expect(gateSweep({ ...base, mode })).toEqual({ ok: false, reason: 'not-auto' })
  }
  expect(gateSweep({ ...base, mode: 'auto', disable: '1' })).toEqual({ ok: false, reason: 'disabled' })
  expect(gateSweep({ ...base, mode: 'auto', isInteractive: false, surface: null })).toEqual({ ok: false, reason: 'headless' })
})

test('modeFromPermissions: the configured permissions.defaultMode, or undefined for anything unusable', () => {
  expect(modeFromPermissions({ defaultMode: 'auto' })).toBe('auto')
  expect(modeFromPermissions({ defaultMode: 'default', allow: [] })).toBe('default')
  for (const p of [undefined, null, {}, { defaultMode: 7 }, { defaultMode: '' }, 'auto', []]) expect(modeFromPermissions(p)).toBe(undefined)
  expect(gateSweep({ isInteractive: true, surface: 'terminal', mode: modeFromPermissions({}) })).toEqual({ ok: false, reason: 'not-auto' })
})

// ─── Report persistence ────────────────────────────────────────────────

test('clockLabel: local HH:MM, zero-padded', () => {
  expect(clockLabel(new Date(2026, 9, 23, 9, 5).getTime())).toBe('09:05')
  expect(clockLabel(new Date(2026, 9, 23, 17, 30).getTime())).toBe('17:30')
})

test('mergeReport: first run is written unchanged; later runs append under a "## Run HH:MM" separator', () => {
  const first = '# CTI sweep 2026-10-23\n\nrun one\n'
  expect(mergeReport(null, first, '09:30')).toBe(first)
  expect(mergeReport('', first, '09:30')).toBe(first)
  const second = '# CTI sweep 2026-10-23\n\nrun two\n'
  const merged = mergeReport(first, second, '14:05')
  expect(merged.startsWith(first)).toBe(true)
  expect(merged).toContain('\n---\n\n## Run 14:05\n\n')
  expect(merged.endsWith(second)).toBe(true)
  const third = mergeReport(merged, 'run three\n', '18:00')
  expect(third.startsWith(merged)).toBe(true)
  expect(third).toContain('## Run 18:00')
  expect(third).toContain('run one')
  expect(third).toContain('run two')
  expect(third).toContain('run three')
})
