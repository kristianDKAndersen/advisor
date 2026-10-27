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

// ─── Feed watcher ──────────────────────────────────────────────────────

import {
  parseFeedsConfig,
  decodeEntities,
  parseRss,
  parseAtom,
  parseKev,
  parseGhsa,
  parseFeed,
  isFeedDue,
  diffFeed,
  recordFailure,
  isNotifyWorthy,
  annotateItem,
  mergeRecent,
  buildFeedToast,
  buildFeedNotification,
  buildStartupToast,
  feedLockPath,
  formatRecentItems,
  formatFeedStatus,
  isOwnAgentReport,
  pruneOwnAgents,
  selectStaleFeedLocks,
  DROP_REASON,
} from '../hooks/register.js'

const RSS = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Chan</title><link>https://x.example/</link>
<atom:link href="https://x.example/feed" rel="self"/>
<item><title><![CDATA[Fix for <b>Next.js</b> & friends]]></title><link>https://x.example/a?x=1&amp;y=2</link><guid isPermaLink="false">g-1</guid><pubDate>Thu, 23 Oct 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Body &amp;amp; more &#39;q&#39; &#x41;&lt;/p&gt;</description><dc:creator>x</dc:creator></item>
<item rdf:about="z"><media:title>wrong</media:title><title>Second &quot;item&quot;</title><atom:link href="https://self/" rel="self"/><link>javascript:alert(1)</link><guid>g-2</guid></item>
<item><title>Third</title><atom:link href="https://self/" rel="self"/><link>https://x.example/c</link></item>
<item><title>Truncated here`

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>S</title><link href="https://socket.example/" rel="self"/>
<entry><title type="html">A &amp; B</title><link rel="alternate" href="https://socket.example/blog/a"/><id>tag:1</id><updated>2026-10-23T08:00:00Z</updated><summary><![CDATA[<p>npm package <b>axios</b></p>]]></summary></entry>
<entry><title>Second</title><link href='https://socket.example/blog/b'/><id>tag:2</id><updated>2026-10-22T08:00:00Z</updated></entry></feed>`

const KEV = JSON.stringify({
  vulnerabilities: [
    { cveID: 'CVE-2026-1', vendorProject: 'Acme', product: 'Widget', vulnerabilityName: 'Acme Widget RCE', dateAdded: '2026-10-01', shortDescription: 'd' },
    { cveID: 'CVE-2026-2', vendorProject: 'Beta', product: 'Gadget', vulnerabilityName: 'Beta Gadget XSS', dateAdded: '2026-10-20' },
    { bad: 1 },
  ],
})

const GHSA = JSON.stringify([
  { ghsa_id: 'GHSA-aaaa', severity: 'critical', summary: 'Malicious code in evil-pkg', html_url: 'https://github.com/advisories/GHSA-aaaa', published_at: '2026-10-23T00:00:00Z', vulnerabilities: [{ package: { ecosystem: 'npm', name: 'evil-pkg' } }] },
  { ghsa_id: 'GHSA-bbbb', severity: 'high', summary: 'x', html_url: 'javascript:1', vulnerabilities: null },
])

test('decodeEntities: named, decimal and hex entities in one pass; unknown entities stay', () => {
  expect(decodeEntities('&lt;a&gt; &amp;amp; &quot;q&quot; &#39;s&#39; &#x41;&#65; &bogus;')).toBe('<a> &amp; "q" \'s\' AA &bogus;')
})

test('parseRss: CDATA, entities, namespaces, tag stripping, http(s)-only links, truncated tail skipped', () => {
  const items = parseRss(RSS)
  expect(items.length).toBe(3)
  expect(items[0].title).toBe('Fix for Next.js & friends')
  expect(items[0].link).toBe('https://x.example/a?x=1&y=2')
  expect(items[0].key).toBe('g-1')
  expect(items[0].date).toBe('Thu, 23 Oct 2026 08:00:00 GMT')
  expect(items[0].text).toBe("Body &amp; more 'q' A")
  expect(items[1].title).toBe('Second "item"')
  expect(items[1].link).toBe('')
  expect(items[1].key).toBe('g-2')
  expect(items[2].link).toBe('https://x.example/c')
  expect(items[2].key).toBe('https://x.example/c')
})

test('parseAtom: entry title/link[href]/id/updated/summary, rel=alternate, single-quoted href', () => {
  const items = parseAtom(ATOM)
  expect(items.length).toBe(2)
  expect(items[0]).toMatchObject({ title: 'A & B', link: 'https://socket.example/blog/a', key: 'tag:1', date: '2026-10-23T08:00:00Z', text: 'npm package axios' })
  expect(items[1].link).toBe('https://socket.example/blog/b')
})

test('parseKev and parseGhsa: field mapping and untrusted links', () => {
  const kev = parseKev(KEV)
  expect(kev.length).toBe(2)
  expect(kev[1]).toMatchObject({
    key: 'CVE-2026-2',
    title: 'KEV: CVE-2026-2 Beta Gadget - Beta Gadget XSS',
    link: 'https://nvd.nist.gov/vuln/detail/CVE-2026-2',
    date: '2026-10-20',
  })
  const ghsa = parseGhsa(GHSA)
  expect(ghsa.length).toBe(2)
  expect(ghsa[0]).toMatchObject({ key: 'GHSA-aaaa', title: 'critical: Malicious code in evil-pkg', link: 'https://github.com/advisories/GHSA-aaaa' })
  expect(ghsa[0].text).toContain('npm evil-pkg')
  expect(ghsa[1].link).toBe('')
  expect(matchesWatchlist({ title: ghsa[0].title, products: [ghsa[0].text] }, ['evil-pkg'])).toBe(true)
})

test('parsers: malformed or wrong-typed input yields [] and never throws', () => {
  for (const bad of [null, undefined, 42, '', '<<<>>>', '<rss><item><title>x', 'not json', '{"vulnerabilities":"x"}', '{"a":1}', '[1,null,"x"]']) {
    expect(parseRss(bad as never)).toEqual([])
    expect(parseAtom(bad as never)).toEqual([])
    expect(parseKev(bad as never)).toEqual([])
    expect(parseGhsa(bad as never)).toEqual([])
  }
  expect(parseFeed('nope', RSS)).toEqual([])
})

test('parseFeed: newest-first order, 200-item window, title cap', () => {
  expect(parseFeed('kev-json', KEV)[0].key).toBe('CVE-2026-2')
  const asc = `<rss><channel>${[1, 2, 3].map(n => `<item><title>t${n}</title><guid>${n}</guid><pubDate>2026-10-0${n}T00:00:00Z</pubDate></item>`).join('')}</channel></rss>`
  expect(parseFeed('rss', asc).map(i => i.key)).toEqual(['3', '2', '1'])
  const big = `<rss><channel>${Array.from({ length: 300 }, (_, n) => `<item><title>${'t'.repeat(300)}</title><guid>${n}</guid></item>`).join('')}</channel></rss>`
  const win = parseFeed('rss', big)
  expect(win.length).toBe(200)
  expect(win[0].title.length <= 200).toBe(true)
  expect(win[0].key).toBe('0')
})

test('parseFeedsConfig: keeps valid entries, drops bad format/notify/url/interval/duplicate ids', () => {
  const ok = { id: 'a', name: 'A', url: 'https://a.example/feed.xml', format: 'rss', intervalMin: 60, notify: 'watchlist' }
  const cfg = parseFeedsConfig(JSON.stringify([
    ok,
    { ...ok, id: 'b', format: 'yaml' },
    { ...ok, id: 'c', notify: 'sometimes' },
    { ...ok, id: 'd', url: 'file:///etc/passwd' },
    { ...ok, id: 'e', intervalMin: 0 },
    { ...ok, id: 'a' },
    { ...ok, id: 'f', url: 'https://api.github.com/advisories?type=malware&per_page=30', format: 'ghsa-json' },
    null,
  ]))
  expect(cfg.map(f => f.id)).toEqual(['a', 'f'])
  expect(parseFeedsConfig('garbage')).toEqual([])
  expect(parseFeedsConfig('{}')).toEqual([])
})

test('isFeedDue: never fetched is due; interval minus 60s slack', () => {
  const feed = { id: 'a', intervalMin: 60 }
  expect(isFeedDue(feed, undefined, NOW)).toBe(true)
  expect(isFeedDue(feed, { failures: 1 }, NOW)).toBe(true)
  expect(isFeedDue(feed, { lastFetched: NOW - 30 * 60000 }, NOW)).toBe(false)
  expect(isFeedDue(feed, { lastFetched: NOW - 58 * 60000 }, NOW)).toBe(false)
  expect(isFeedDue(feed, { lastFetched: NOW - 60 * 60000 + 30000 }, NOW)).toBe(true)
})

const mk = (...keys: string[]) => keys.map(key => ({ key, title: 't' + key, link: '', date: '', text: '' }))

test('diffFeed: first success is a silent baseline, then only unseen items are new', () => {
  const base = diffFeed(undefined, mk('1', '2', '3'), NOW)
  expect(base.ok).toBe(true)
  expect(base.baseline).toBe(true)
  expect(base.fresh).toEqual([])
  expect(base.entry.seen).toEqual(['1', '2', '3'])
  expect(base.entry.lastFetched).toBe(NOW)
  expect(base.entry.failures).toBe(0)
  const next = diffFeed(base.entry, mk('4', '1', '2', '3'), NOW + 1)
  expect(next.baseline).toBe(false)
  expect(next.fresh.map(i => i.key)).toEqual(['4'])
  expect(next.entry.seen).toEqual(['4', '1', '2', '3'])
  expect(diffFeed(next.entry, mk('4', '1', '2', '3'), NOW + 2).fresh).toEqual([])
})

test('diffFeed: a full window re-polled is never new; seen keeps old keys, capped at 500', () => {
  const keys = Array.from({ length: 200 }, (_, n) => 'k' + n)
  const base = diffFeed(undefined, mk(...keys), NOW)
  expect(diffFeed(base.entry, mk(...keys), NOW + 1).fresh).toEqual([])
  expect(diffFeed({ seen: ['a', 'b'] }, mk('c'), NOW).entry.seen).toEqual(['c', 'a', 'b'])
  const old = Array.from({ length: 600 }, (_, n) => 'o' + n)
  const capped = diffFeed({ seen: old }, mk('n1'), NOW)
  expect(capped.entry.seen.length).toBe(500)
  expect(capped.entry.seen[0]).toBe('n1')
})

test('diffFeed: zero parsed items is a failure, never a baseline; recordFailure keeps seen', () => {
  const r = diffFeed(undefined, [], NOW)
  expect(r.ok).toBe(false)
  expect(r.entry.seen).toBe(undefined)
  expect(r.entry.failures).toBe(1)
  const f = recordFailure({ seen: ['x'], failures: 1, lastFetched: 1 }, NOW, 'HTTP 503')
  expect(f).toMatchObject({ seen: ['x'], failures: 2, lastFetched: NOW, lastResult: 'error: HTTP 503' })
})

test('isNotifyWorthy: always, never, watchlist on title+text', () => {
  const item = { key: 'k', title: 'Axios compromised', link: '', date: '', text: 'npm package axios' }
  expect(isNotifyWorthy({ notify: 'always' }, item, [])).toBe(true)
  expect(isNotifyWorthy({ notify: 'never' }, item, ['axios'])).toBe(false)
  expect(isNotifyWorthy({ notify: 'watchlist' }, item, ['axios'])).toBe(true)
  expect(isNotifyWorthy({ notify: 'watchlist' }, { ...item, title: 'Other' }, ['axios'])).toBe(true)
  expect(isNotifyWorthy({ notify: 'watchlist' }, { ...item, title: 'Other', text: 'nothing' }, ['axios'])).toBe(false)
  expect(isNotifyWorthy({ notify: 'watchlist' }, item, [])).toBe(false)
})

test('annotateItem: tags watchlist and KEV, drops body text', () => {
  const feed = { id: 'kev', name: 'CISA KEV', format: 'kev-json', notify: 'always' }
  const a = annotateItem(feed, { key: 'CVE-1', title: 'KEV: CVE-1 Next.js - flaw', link: 'https://nvd.nist.gov/vuln/detail/CVE-1', date: '', text: 'long' }, ['next.js'], NOW)
  expect(a).toEqual({ at: NOW, feedId: 'kev', feed: 'CISA KEV', key: 'CVE-1', title: 'KEV: CVE-1 Next.js - flaw', link: 'https://nvd.nist.gov/vuln/detail/CVE-1', watch: true, kev: true, worthy: true })
  const b = annotateItem({ ...feed, format: 'rss', notify: 'never' }, { key: 'x', title: 'Plain', link: '', date: '', text: '' }, ['next.js'], NOW)
  expect(b).toMatchObject({ watch: false, kev: false, worthy: false })
})

test('mergeRecent: newest first, capped at 100', () => {
  const mkA = (n: number) => ({ at: n, feedId: 'f', feed: 'F', key: 'k' + n, title: 't', link: '', watch: false, kev: false, worthy: false })
  const merged = mergeRecent(Array.from({ length: 99 }, (_, n) => mkA(n)), [mkA(1000), mkA(1001)])
  expect(merged.length).toBe(100)
  expect(merged[0].at).toBe(1000)
  expect(mergeRecent(undefined as never, [mkA(1)]).length).toBe(1)
})

test('buildFeedToast and buildFeedNotification: counts, stack clause, watchlist-first top title', () => {
  expect(buildFeedToast(3, 1)).toBe('CTI feeds: 3 new (1 on your stack) - /cti feed')
  expect(buildFeedToast(2, 0)).toBe('CTI feeds: 2 new - /cti feed')
  const it = (title: string, worthy: boolean, watch = false) => ({ at: NOW, feedId: 'f', feed: 'F', key: title, title, link: '', watch, kev: false, worthy })
  expect(buildFeedNotification([it('a', false)])).toBe(null)
  expect(buildFeedNotification([])).toBe(null)
  expect(buildFeedNotification([it('a', false), it('only', true)])).toBe('CTI feed: only')
  expect(buildFeedNotification([it('plain', true), it('stack', true, true)])).toBe('CTI feed: 2 new - stack')
  expect(buildFeedNotification([it('x'.repeat(300), true)])!.length <= 140).toBe(true)
})

test('buildStartupToast: unread digest alerts, feed items, both, neither', () => {
  const digest = { finishedAt: 2000, alerts: [{ id: 'a' }, { id: 'b' }] }
  const recent = [
    { at: 3000, worthy: true },
    { at: 3100, worthy: false },
    { at: 500, worthy: true },
  ]
  expect(buildStartupToast({ digest, digestViewedAt: 1000, recent: [], feedViewedAt: 0 })).toBe('CTI: 2 alerts today - /cti for details')
  expect(buildStartupToast({ digest: { ...digest, alerts: [{ id: 'a' }] }, recent: [], feedViewedAt: 0 })).toBe('CTI: 1 alert today - /cti for details')
  expect(buildStartupToast({ digest, digestViewedAt: 1000, recent, feedViewedAt: 1000 })).toBe('CTI: 2 alerts today - /cti for details - 1 new feed item')
  expect(buildStartupToast({ digest, digestViewedAt: 2000, recent, feedViewedAt: 1000 })).toBe('CTI: 1 new feed item - /cti feed')
  expect(buildStartupToast({ digest: undefined, recent: [recent[0], { at: 3200, worthy: true }], feedViewedAt: 1000 })).toBe('CTI: 2 new feed items - /cti feed')
  expect(buildStartupToast({ digest: { finishedAt: 2000, alerts: [] }, digestViewedAt: 0, recent, feedViewedAt: 5000 })).toBe(null)
  expect(buildStartupToast({ digest: 'junk', recent: 'junk', feedViewedAt: 'x' } as never)).toBe(null)
})

test('feedLockPath: one lock per 5-minute slot, distinct from the day-claim locks', () => {
  const slot = Math.floor(NOW / 300000)
  expect(feedLockPath('/h/.advisor/cti', NOW)).toBe('/h/.advisor/cti/.locks/feeds-' + slot)
  expect(feedLockPath('/h/.advisor/cti', NOW + 299999 - (NOW % 300000))).toBe('/h/.advisor/cti/.locks/feeds-' + slot)
  expect(feedLockPath('/h/.advisor/cti', NOW + 300000)).toBe('/h/.advisor/cti/.locks/feeds-' + (slot + 1))
})

test('formatRecentItems and formatFeedStatus', () => {
  expect(formatRecentItems([])).toBe('No new feed items yet.')
  const recent = Array.from({ length: 40 }, (_, n) => ({ at: NOW - n * 60000, feedId: 'f', feed: 'Feed', key: 'k' + n, title: 'title' + n, link: 'https://e.example/' + n, watch: n === 0, kev: n === 1, worthy: false }))
  const lines = formatRecentItems(recent).split('\n')
  expect(lines.length).toBe(30)
  expect(lines[0]).toBe('10-23 09:30 [WATCHLIST] Feed: title0 <https://e.example/0>')
  expect(lines[1]).toContain('[KEV]')
  expect(lines[2]).not.toContain('[')
  const feeds = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
  const out = formatFeedStatus(feeds, { a: { lastFetched: NOW, lastResult: 'ok: 2 new', failures: 0 }, b: { failures: 2, lastFetched: NOW, lastResult: 'error: HTTP 503' } }, NOW)
  expect(out).toContain('Alpha: last fetch 09:30, ok: 2 new, failures 0')
  expect(out).toContain('Beta: last fetch 09:30, error: HTTP 503, failures 2')
  expect(formatFeedStatus([{ id: 'c', name: 'Gamma' }], {}, NOW)).toContain('Gamma: never fetched')
})

test('isOwnAgentReport: only the sweep agent\'s own hand-back is matched', () => {
  const ids = new Set(['a1b2c3'])
  const peer = { kind: 'peer' }
  expect(isOwnAgentReport('<agent-message from="a1b2c3">\n```json\n[]\n```', ids, peer)).toBe(true)
  expect(isOwnAgentReport('  \n<agent-message from="a1b2c3">x', ids, peer)).toBe(true)
  expect(isOwnAgentReport('<agent-message from="zzz999">x', ids, peer)).toBe(false)
  expect(isOwnAgentReport('<agent-message from="a1b2c3x">x', ids, peer)).toBe(false)
  expect(isOwnAgentReport('please read <agent-message from="a1b2c3"> for me', ids, { kind: 'user' })).toBe(false)
  expect(isOwnAgentReport('<agent-message from="a1b2c3">x', new Set(), peer)).toBe(false)
  expect(isOwnAgentReport('<agent-message from="a1b2c3">x', [], peer)).toBe(false)
  expect(isOwnAgentReport('Agent a1b2c3 finished: result', ids, { kind: 'task-notification' })).toBe(true)
  expect(isOwnAgentReport('Agent a1b2c3x finished', ids, { kind: 'task-notification' })).toBe(false)
  expect(isOwnAgentReport('Agent a1b2c3 finished', ids, { kind: 'user' })).toBe(false)
  expect(isOwnAgentReport(undefined as never, ids, peer)).toBe(false)
})

test('DROP_REASON is fixed text that cannot carry agent output', () => {
  expect(DROP_REASON).toBe('cti-sweep: sweep result kept out of the conversation - see /cti')
})

test('pruneOwnAgents: drops entries older than 24h and junk', () => {
  const day = 24 * HOUR
  const out = pruneOwnAgents({ old: NOW - day - 1, fresh: NOW - day + 1000, junk: 'x' } as never, NOW)
  expect(out).toEqual({ fresh: NOW - day + 1000 })
  expect(pruneOwnAgents(undefined, NOW)).toEqual({})
  expect(pruneOwnAgents('junk' as never, NOW)).toEqual({})
})

test('feedLockPath: forced polls get their own lock, scheduled ones share the slot', () => {
  const slot = Math.floor(NOW / 300000)
  expect(feedLockPath('/h/.advisor/cti', NOW, false)).toBe('/h/.advisor/cti/.locks/feeds-' + slot)
  expect(feedLockPath('/h/.advisor/cti', NOW, true)).toBe('/h/.advisor/cti/.locks/feeds-f' + NOW)
  expect(feedLockPath('/h/.advisor/cti', NOW + 1, true)).not.toBe(feedLockPath('/h/.advisor/cti', NOW, true))
})

test('selectStaleFeedLocks: only feed locks older than 2 days', () => {
  const day = 24 * HOUR
  const slotOf = (ms: number) => Math.floor(ms / 300000)
  const names = [
    'feeds-' + slotOf(NOW - 3 * day),
    'feeds-' + slotOf(NOW - day),
    'feeds-f' + (NOW - 3 * day),
    'feeds-f' + (NOW - day),
    '2026-10-01-a1',
    '2026-10-01-f' + (NOW - 5 * day),
    'feeds-',
    'feeds-abc',
    'feeds-f',
    'other',
  ]
  expect(selectStaleFeedLocks(names, NOW)).toEqual([names[0], names[2]])
  expect(selectStaleFeedLocks([], NOW)).toEqual([])
  expect(selectStaleFeedLocks(undefined as never, NOW)).toEqual([])
})

// ─── Forced-sweep toast and cumulative daily digest ───────────────────

import { buildSweepDoneToast, mergeDigest, digestText } from '../hooks/register.js'

const runOf = (finishedAt: number, ids: string[], findings = ids.length, date = '2026-10-23') => ({
  date,
  finishedAt,
  findings,
  invalid: 0,
  alerts: ids.map(id => ({ id, title: 't-' + id, severity: 'high' })),
  reportPath: '/r/' + date + '.md',
})

test('buildSweepDoneToast: outcome, refusal, failure', () => {
  expect(buildSweepDoneToast({ ok: true, findings: 0, alerts: 0, alertsToday: 12 })).toBe('CTI sweep done: 0 new findings, 0 new alerts (12 alerts today) - /cti')
  expect(buildSweepDoneToast({ ok: true, findings: 1, alerts: 1, alertsToday: 1 })).toBe('CTI sweep done: 1 new finding, 1 new alert (1 alert today) - /cti')
  expect(buildSweepDoneToast({ ok: false, reason: 'done' })).toBe('CTI sweep not run: done')
  expect(buildSweepDoneToast({ ok: false, reason: 'locked' })).toBe('CTI sweep not run: locked')
  expect(buildSweepDoneToast({ ok: false, reason: 'failed' })).toBe(null)
  expect(buildSweepDoneToast(undefined as never)).toBe(null)
})

test('mergeDigest: same-day union deduped by id, newest first, sums, last run', () => {
  const first = mergeDigest(undefined, runOf(1000, ['a', 'b'], 5))
  expect(first.runs).toBe(1)
  expect(first.alertsAt).toBe(1000)
  const second = mergeDigest(first, runOf(2000, ['c', 'a'], 3))
  expect(second.alerts.map((a: { id: string }) => a.id)).toEqual(['c', 'a', 'b'])
  expect(second.findings).toBe(8)
  expect(second.runs).toBe(2)
  expect(second.alertsAt).toBe(2000)
  expect(second.finishedAt).toBe(2000)
  expect(second.last).toEqual({ at: 2000, findings: 3, alerts: 2 })
  const third = mergeDigest(second, runOf(3000, [], 0))
  expect(third.alerts.length).toBe(3)
  expect(third.runs).toBe(3)
  expect(third.alertsAt).toBe(2000)
  expect(third.last).toEqual({ at: 3000, findings: 0, alerts: 0 })
  expect(mergeDigest(third, runOf(4000, ['a'])).alertsAt).toBe(2000)
})

test('mergeDigest: new date starts fresh', () => {
  const prev = mergeDigest(undefined, runOf(1000, ['a', 'b'], 5, '2026-10-22'))
  const next = mergeDigest(prev, runOf(2000, [], 0))
  expect(next.alerts).toEqual([])
  expect(next.runs).toBe(1)
  expect(next.findings).toBe(0)
  expect(next.alertsAt).toBe(0)
})

test('mergeDigest: old-shape digest merges as one prior run', () => {
  const old = { date: '2026-10-23', finishedAt: 500, findings: 4, invalid: 1, alerts: [{ id: 'a', title: 't', severity: 'high' }], reportPath: '/r' }
  const merged = mergeDigest(old, runOf(900, ['b'], 2))
  expect(merged.alerts.map((a: { id: string }) => a.id)).toEqual(['b', 'a'])
  expect(merged.runs).toBe(2)
  expect(merged.findings).toBe(6)
  expect(merged.invalid).toBe(1)
  const quiet = mergeDigest(old, runOf(900, [], 0))
  expect(quiet.alertsAt).toBe(500)
  expect(mergeDigest('junk' as never, runOf(900, ['b'])).runs).toBe(1)
})

test('digestText: day totals, last run, alert lines; old shape renders', () => {
  const merged = mergeDigest(mergeDigest(undefined, runOf(1000, ['a'], 2)), runOf(2000, [], 0))
  const text = digestText(merged)
  const lines = text.split('\n')
  expect(lines[0]).toMatch(/^CTI sweep 2026-10-23: 1 alert today across 2 runs \(last \d\d:\d\d: 0 new findings\)$/)
  expect(lines[1]).toBe('- [high] t-a (a)')
  expect(lines[2]).toBe('Report: /r/2026-10-23.md')
  const old = digestText({ date: '2026-10-23', finishedAt: 500, findings: 4, invalid: 0, alerts: [], reportPath: '/r' })
  expect(old).toMatch(/0 alerts today across 1 run \(last \d\d:\d\d: 4 new findings\)/)
  expect(digestText(undefined)).toBe('No CTI sweep has completed yet.')
})

test('buildStartupToast: a later 0-alert run does not re-raise viewed alerts', () => {
  const merged = mergeDigest(mergeDigest(undefined, runOf(1000, ['a'])), runOf(3000, [], 0))
  expect(buildStartupToast({ digest: merged, digestViewedAt: 2000, recent: [], feedViewedAt: 0 })).toBe(null)
  expect(buildStartupToast({ digest: merged, digestViewedAt: 500, recent: [], feedViewedAt: 0 })).toBe('CTI: 1 alert today - /cti for details')
  const old = { finishedAt: 2000, alerts: [{ id: 'a' }] }
  expect(buildStartupToast({ digest: old, digestViewedAt: 1000, recent: [], feedViewedAt: 0 })).toBe('CTI: 1 alert today - /cti for details')
})

test('buildStartupToast: counts only alerts added after the last view', () => {
  const merged = mergeDigest(mergeDigest(undefined, runOf(1000, ['a', 'b', 'c'])), runOf(3000, ['d']))
  expect(merged.alerts.length).toBe(4)
  expect(buildStartupToast({ digest: merged, digestViewedAt: 2000, recent: [], feedViewedAt: 0 })).toBe('CTI: 1 alert today - /cti for details')
  expect(buildStartupToast({ digest: merged, digestViewedAt: 500, recent: [], feedViewedAt: 0 })).toBe('CTI: 4 alerts today - /cti for details')
  expect(buildStartupToast({ digest: merged, digestViewedAt: 3000, recent: [], feedViewedAt: 0 })).toBe(null)
  const old = { finishedAt: 2000, alerts: [{ id: 'x' }, { id: 'y' }] }
  expect(buildStartupToast({ digest: old, digestViewedAt: 1000, recent: [], feedViewedAt: 0 })).toBe('CTI: 2 alerts today - /cti for details')
  const oldThenNew = mergeDigest({ date: '2026-10-23', finishedAt: 1000, alerts: [{ id: 'x' }], reportPath: '/r' }, runOf(3000, ['d']))
  expect(buildStartupToast({ digest: oldThenNew, digestViewedAt: 2000, recent: [], feedViewedAt: 0 })).toBe('CTI: 1 alert today - /cti for details')
})

test('mergeDigest: duplicate ids inside one run are added once', () => {
  const merged = mergeDigest(undefined, runOf(1000, ['a', 'b', 'a']))
  expect(merged.alerts.map(a => a.id)).toEqual(['a', 'b'])
  expect(merged.last.alerts).toBe(3)
})

import { register, safeSweep } from '../hooks/register.js'

const SWEEP_NOW = new Date(2026, 9, 26, 12, 0, 0).getTime()
const sweepAnswer = (ids: string[]) =>
  '```json\n' +
  JSON.stringify({
    date: '2026-10-26',
    findings: ids.map(id => ({
      id,
      title: 'Bad thing ' + id,
      category: 'vulnerability',
      severity: 'critical',
      exploited: true,
      products: ['acme'],
      summary: 's',
      action: 'patch',
      sources: ['https://example.com/advisory/' + id],
    })),
  }) +
  '\n```'

// Stub $ for safeSweep: answer is delivered through the turn.complete handler, like the real agent.
function sweepHarness(opts: { answer?: string | null; spawn?: object; lockExit?: number; toastThrows?: boolean; storeGetThrows?: boolean } = {}) {
  const toasts: string[] = []
  const notices: string[] = []
  const handlers: Record<string, Function> = {}
  register(((name: string, ...rest: unknown[]) => {
    handlers[name] = rest[rest.length - 1] as Function
    return { catch() {} }
  }) as never, { watchlist: '' } as never)
  const store = new Map<string, unknown>()
  const $: any = {
    store: {
      get: async (k: string) => {
        if (opts.storeGetThrows) throw new Error('store down')
        return store.get(k)
      },
      set: async (k: string, v: unknown) => void store.set(k, v),
    },
    env: { get: async () => '/home/u' },
    clock: {
      now: async () => SWEEP_NOW,
      after: (_ms: number, _cb: () => void) => {
        setTimeout(() => handlers['turn.complete']($, { agentId: 'ag1', answer: opts.answer === undefined ? sweepAnswer([]) : opts.answer }, async () => {}), 0)
      },
    },
    process: { run: async () => ({ exitCode: opts.lockExit ?? 0 }) },
    fs: { read: async () => { throw new Error('none') }, write: async () => {} },
    agent: { spawn: async () => opts.spawn ?? { agentId: 'ag1' } },
    plugin: { root: '/p' },
    ui: {
      log: () => {},
      notify: async (t: string) => { notices.push(t); return { isSent: true } },
      toast: async (t: string, ...extra: unknown[]) => {
        if (opts.toastThrows) throw new Error('no surface')
        toasts.push(t + (extra.length ? ' +opts' : ''))
      },
    },
  }
  return { $, toasts, notices, store }
}

test('safeSweep: forced run toasts the outcome, scheduled run does not', async () => {
  const forced = sweepHarness({ answer: sweepAnswer([]) })
  expect((await safeSweep(forced.$, true)).ok).toBe(true)
  expect(forced.toasts).toEqual(['CTI sweep done: 0 new findings, 0 new alerts (0 alerts today) - /cti'])
  const scheduled = sweepHarness({ answer: sweepAnswer([]) })
  expect((await safeSweep(scheduled.$, false)).ok).toBe(true)
  expect(scheduled.toasts).toEqual([])
  const refused = sweepHarness({ lockExit: 1 })
  expect((await safeSweep(refused.$, true)).reason).toBe('locked')
  expect(refused.toasts).toEqual(['CTI sweep not run: locked'])
})

test('safeSweep: a failed sweep gives one failure toast and no done toast', async () => {
  const h = sweepHarness({ spawn: {} })
  expect((await safeSweep(h.$, true)).reason).toBe('failed')
  expect(h.toasts.length).toBe(1)
  expect(h.toasts[0]).toMatch(/^CTI sweep failed: spawn refused/)
})

test('safeSweep: a toast that throws is swallowed', async () => {
  const h = sweepHarness({ answer: sweepAnswer([]), toastThrows: true })
  expect((await safeSweep(h.$, true)).ok).toBe(true)
})

test('safeSweep: a crash toasts for forced runs only', async () => {
  const forced = sweepHarness({ storeGetThrows: true })
  expect((await safeSweep(forced.$, true)).reason).toBe('crashed')
  expect(forced.toasts).toEqual(['CTI sweep crashed - see log'])
  const scheduled = sweepHarness({ storeGetThrows: true })
  expect((await safeSweep(scheduled.$, false)).reason).toBe('crashed')
  expect(scheduled.toasts).toEqual([])
  const noSurface = sweepHarness({ storeGetThrows: true, toastThrows: true })
  expect((await safeSweep(noSurface.$, true)).reason).toBe('crashed')
})

test('safeSweep: forced run with alerts shows one toast, scheduled keeps the alert toast', async () => {
  const forced = sweepHarness({ answer: sweepAnswer(['a1', 'a2']) })
  expect((await safeSweep(forced.$, true)).alerts).toBe(2)
  expect(forced.notices.length).toBe(1)
  expect(forced.toasts).toEqual(['CTI sweep done: 2 new findings, 2 new alerts (2 alerts today) - /cti'])
  const scheduled = sweepHarness({ answer: sweepAnswer(['a1', 'a2']) })
  await safeSweep(scheduled.$, false)
  expect(scheduled.notices.length).toBe(1)
  expect(scheduled.toasts).toEqual([scheduled.notices[0]])
})

// ─── Click-to-open notifications (terminal-notifier) ──────────────────

import { buildOpenUrl, buildTerminalNotifierArgv, notify, deliverFresh } from '../hooks/register.js'

const CTI_DIR = '/home/u/.advisor/cti'
const BREW_TN = '/opt/homebrew/bin/terminal-notifier'
const INTEL_TN = '/usr/local/bin/terminal-notifier'

test('buildOpenUrl: file URL percent-encoded; null outside ctiDir, on traversal, or for the dir itself', () => {
  expect(buildOpenUrl(CTI_DIR + '/2026-10-26.md', CTI_DIR)).toBe('file:///home/u/.advisor/cti/2026-10-26.md')
  expect(buildOpenUrl('/Users/a b/.advisor/cti/feed 1.md', '/Users/a b/.advisor/cti')).toBe('file:///Users/a%20b/.advisor/cti/feed%201.md')
  expect(buildOpenUrl('/home/u/.advisor/other/x.md', CTI_DIR)).toBe(null)
  expect(buildOpenUrl('/home/u/.advisor/cti-evil/x.md', CTI_DIR)).toBe(null)
  expect(buildOpenUrl(CTI_DIR + '/../secret.md', CTI_DIR)).toBe(null)
  expect(buildOpenUrl(CTI_DIR + '/', CTI_DIR)).toBe(null)
  expect(buildOpenUrl(CTI_DIR, CTI_DIR)).toBe(null)
  expect(buildOpenUrl(undefined as never, CTI_DIR)).toBe(null)
})

test('buildTerminalNotifierArgv: one element per value, no -sender, flag-like text padded, no -open without a URL', () => {
  const url = 'file:///home/u/.advisor/cti/2026-10-26.md'
  expect(buildTerminalNotifierArgv('CTI: 1 alert', 'CTI sweep', url)).toEqual(['-title', 'CTI sweep', '-message', 'CTI: 1 alert', '-open', url, '-group', 'cti-sweep'])
  const flagLike = buildTerminalNotifierArgv('-execute rm -rf ~', 'CTI sweep', url)
  expect(flagLike[3]).toBe(' -execute rm -rf ~')
  expect(buildTerminalNotifierArgv('[x] y', 'CTI sweep', url)[3]).toBe(' [x] y')
  const spaced = buildOpenUrl('/Users/a b/.advisor/cti/feed 1.md', '/Users/a b/.advisor/cti')
  expect(buildTerminalNotifierArgv('t', 'T', spaced)).toContain('file:///Users/a%20b/.advisor/cti/feed%201.md')
  const none = buildTerminalNotifierArgv('t', 'T', buildOpenUrl('/etc/passwd', CTI_DIR))
  expect(none).toEqual(['-title', 'T', '-message', 't', '-group', 'cti-sweep'])
  expect(none).not.toContain('-open')
  expect(flagLike).not.toContain('-sender')
})

// Stub $ for notify: `bins` are the terminal-notifier paths that exist, tnExit its exit code.
function notifyHarness(opts: { sent?: boolean; bins?: string[]; tnExit?: number } = {}) {
  const runs: string[][] = []
  const $: any = {
    env: { get: async () => '/home/u' },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv)
        if (argv[0] === 'test') return { exitCode: (opts.bins ?? []).includes(argv[2]) ? 0 : 1 }
        if (argv[0].endsWith('terminal-notifier')) return { exitCode: opts.tnExit ?? 0 }
        return { exitCode: 0 }
      },
    },
    ui: { log: () => {}, notify: async () => ({ isSent: opts.sent ?? false }), toast: async () => {} },
  }
  return { $, runs }
}

const REPORT = CTI_DIR + '/2026-10-26.md'
const REPORT_URL = 'file://' + REPORT

test('notify: $.ui.notify sent -> no process spawned at all', async () => {
  const h = notifyHarness({ sent: true, bins: [BREW_TN] })
  await notify(h.$, 'hello', undefined, REPORT)
  expect(h.runs).toEqual([])
})

test('notify: not sent + openPath + homebrew terminal-notifier -> its argv, osascript not used', async () => {
  const h = notifyHarness({ bins: [BREW_TN, INTEL_TN] })
  await notify(h.$, 'hello', undefined, REPORT)
  expect(h.runs).toEqual([['test', '-x', BREW_TN], [BREW_TN, ...buildTerminalNotifierArgv('hello', 'CTI sweep', REPORT_URL)]])
})

test('notify: only /usr/local/bin terminal-notifier exists -> it is used', async () => {
  const h = notifyHarness({ bins: [INTEL_TN] })
  await notify(h.$, 'hello', undefined, REPORT)
  expect(h.runs.map(r => r[0])).toEqual(['test', 'test', INTEL_TN])
})

test('notify: terminal-notifier missing -> osascript fallback unchanged', async () => {
  const h = notifyHarness({ bins: [] })
  await notify(h.$, 'hello', undefined, REPORT)
  expect(h.runs[h.runs.length - 1]).toEqual(buildOsascriptArgv('hello', 'CTI sweep'))
  expect(h.runs.some(r => r[0].endsWith('terminal-notifier'))).toBe(false)
})

test('notify: terminal-notifier exits non-zero -> osascript fallback', async () => {
  const h = notifyHarness({ bins: [BREW_TN], tnExit: 1 })
  await notify(h.$, 'hello', undefined, REPORT)
  expect(h.runs[h.runs.length - 1]).toEqual(buildOsascriptArgv('hello', 'CTI sweep'))
})

test('notify: no openPath, or openPath outside ctiDir -> osascript only, terminal-notifier never probed', async () => {
  for (const p of [undefined, null, '/home/u/elsewhere/x.md', CTI_DIR + '/../x.md']) {
    const h = notifyHarness({ bins: [BREW_TN] })
    await notify(h.$, 'hello', undefined, p as never)
    expect(h.runs).toEqual([buildOsascriptArgv('hello', 'CTI sweep')])
  }
})

// Drive a sweep with a notifier that is not sent and record every spawned argv.
function sweepNotifyRun(opts: { answer?: string | null; spawn?: object; reportExists?: boolean }) {
  const h = sweepHarness({ answer: opts.answer, spawn: opts.spawn })
  const runs: string[][] = []
  h.$.ui.notify = async () => ({ isSent: false })
  h.$.process.run = async (argv: string[]) => {
    runs.push(argv)
    if (argv[0] === 'test') return { exitCode: argv[2] === BREW_TN ? 0 : 1 }
    return { exitCode: 0 }
  }
  if (opts.reportExists) h.$.fs.read = async () => '# existing report\n'
  return { h, runs }
}

const tnRuns = (runs: string[][]) => runs.filter(r => r[0] === BREW_TN)

test('call site: sweep result opens the day report', async () => {
  const { h, runs } = sweepNotifyRun({ answer: sweepAnswer(['a1']) })
  await safeSweep(h.$, false)
  const tn = tnRuns(runs)
  expect(tn.length).toBe(1)
  expect(tn[0].slice(tn[0].indexOf('-open'), tn[0].indexOf('-open') + 2)).toEqual(['-open', REPORT_URL])
})

test('call site: sweep failure opens the day report only when it exists', async () => {
  const absent = sweepNotifyRun({ spawn: { deny: 'no' } })
  await safeSweep(absent.h.$, false)
  expect(tnRuns(absent.runs)).toEqual([])
  expect(absent.runs[absent.runs.length - 1][0]).toBe('osascript')
  const present = sweepNotifyRun({ spawn: { deny: 'no' }, reportExists: true })
  await safeSweep(present.h.$, false)
  const tn = tnRuns(present.runs)
  expect(tn.length).toBe(1)
  expect(tn[0]).toContain(REPORT_URL)
  expect(tn[0][4]).toMatch(/^CTI sweep failed: spawn refused/)
})

test('call site: feed alert opens the feed log; a failed log write omits -open', async () => {
  const item = { at: SWEEP_NOW, feedId: 'kev', feed: 'CISA KEV', key: 'k', title: 'Bad', link: '', watch: true, kev: true, worthy: true }
  const feedRun = async (writeFails: boolean) => {
    const h = sweepHarness()
    const runs: string[][] = []
    h.$.ui.notify = async () => ({ isSent: false })
    h.$.process.run = async (argv: string[]) => {
      runs.push(argv)
      return { exitCode: argv[0] === 'test' ? (argv[2] === BREW_TN ? 0 : 1) : 0 }
    }
    if (writeFails) h.$.fs.write = async () => { throw new Error('disk full') }
    await deliverFresh(h.$, CTI_DIR, [item], SWEEP_NOW)
    return runs
  }
  const ok = tnRuns(await feedRun(false))
  expect(ok.length).toBe(1)
  expect(ok[0]).toContain('file://' + CTI_DIR + '/feed-2026-10-26.md')
  const failed = await feedRun(true)
  expect(tnRuns(failed)).toEqual([])
  expect(failed[failed.length - 1][0]).toBe('osascript')
})
