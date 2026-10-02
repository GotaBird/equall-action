import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCheck, buildClosed, classify, isAllowedUrl, send } from '../report.mjs'

const KEY = '9f3b6b1a-2e4e-4b3a-8f1a-6b2a7b2c9d10'

const issue = (over = {}) => ({
  scanner: 'axe-core',
  scanner_rule_id: 'image-alt',
  wcag_criteria: ['1.1.1'],
  wcag_level: 'A',
  pour: 'perceivable',
  file_path: 'src/Hero.tsx',
  line: 12,
  column: 4,
  html_snippet: '<img src="hero.png">',
  severity: 'critical',
  message: 'Image element missing an alt attribute',
  help_url: 'https://example.com/help',
  suggestion: 'Add an alt attribute',
  fingerprint: 'abc123',
  ...over,
})

const result = {
  base: 'b'.repeat(40),
  head: 'c'.repeat(40),
  merge_base: 'd'.repeat(40),
  new_issues: [issue(), issue({ severity: 'serious', fingerprint: 'def456' })],
  new_review_only: [issue({ severity: 'moderate', fingerprint: 'r1', review_only: true })],
  new_advisory: [issue({ severity: 'minor', fingerprint: null, line: null })],
  legacy_issues: [issue({ fingerprint: 'old' })],
  not_testable: [],
  excluded: [],
  unchecked: [],
  summary: {
    files_changed: 3, files_scanned: 2, new_count: 2, new_review_only_count: 1,
    new_advisory_count: 1, legacy_count: 1, not_testable_count: 0, excluded_count: 0, unchecked_count: 0,
  },
}

const event = {
  action: 'synchronize',
  repository: { id: 123456789, full_name: 'acme/site' },
  pull_request: {
    number: 42,
    title: 'Fix the hero',
    user: { login: 'octocat' },
    base: { ref: 'main' },
    head: { sha: 'a'.repeat(40), repo: { full_name: 'acme/site' } },
    merged: false,
  },
}

const env = { GITHUB_RUN_ID: '9876543210', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'e'.repeat(40) }

const check = (over = {}) =>
  buildCheck({ result, exitCode: 1, event, env, engineVersion: '0.3.4', failOn: 'critical', projectKey: KEY, now: new Date('2026-10-02T12:00:00Z'), ...over })

test('check: identity and PR metadata come from the event, never GITHUB_SHA', () => {
  const { envelope } = check()
  assert.equal(envelope.kind, 'check')
  assert.equal(envelope.payload_version, 1)
  assert.equal(envelope.repository_id, '123456789')
  assert.equal(envelope.project_key, KEY)
  assert.equal(envelope.pr_number, 42)
  assert.equal(envelope.head_sha, 'a'.repeat(40))
  assert.equal(envelope.base_ref, 'main')
  assert.equal(envelope.merge_base_sha, 'd'.repeat(40))
  assert.equal(envelope.gh_run_id, '9876543210')
  assert.equal(envelope.gh_run_attempt, 2)
  assert.equal(envelope.title, 'Fix the hero')
  assert.equal(envelope.author_login, 'octocat')
  assert.equal(envelope.checked_at, '2026-10-02T12:00:00.000Z')
  assert.ok(!JSON.stringify(envelope).includes('e'.repeat(40)))
})

test('check: passed follows the gate exit code, fail_on is stored as given', () => {
  assert.equal(check().envelope.passed, false)
  assert.equal(check({ exitCode: 0 }).envelope.passed, true)
  assert.equal(check().envelope.fail_on, 'critical')
  assert.equal(check({ failOn: 'nonsense' }).envelope.fail_on, null)
})

test('check: counts by severity and from the summary', () => {
  assert.deepEqual(check().envelope.counts, {
    new_critical: 1, new_serious: 1, new_moderate: 0, new_minor: 0,
    review_only_count: 1, advisory_count: 1, legacy_count: 1, unchecked_count: 0,
  })
})

test('check: findings carry only allow-listed fields, never snippets or suggestions', () => {
  const { envelope } = check()
  const body = JSON.stringify(envelope)
  for (const leaked of ['html_snippet', 'suggestion', 'help_url', 'column', 'hero.png', 'Add an alt']) {
    assert.ok(!body.includes(leaked), `${leaked} must not be sent`)
  }
  assert.deepEqual(Object.keys(envelope.findings[0]).sort(), [
    'file_path', 'fingerprint', 'kind', 'line', 'message', 'scanner', 'scanner_rule_id', 'severity', 'wcag_criteria',
  ])
  assert.deepEqual(envelope.findings.map((f) => f.kind), ['new', 'new', 'review_only'])
})

test('check: a finding with no fingerprint and no line is dropped and counted', () => {
  const { envelope, dropped } = check()
  assert.equal(dropped, 1)
  assert.ok(!envelope.findings.some((f) => f.kind === 'advisory'))
})

test('check: empty strings and invalid lines become null', () => {
  const r = { ...result, new_issues: [issue({ fingerprint: '', scanner_rule_id: 'x', line: 0 })], new_review_only: [], new_advisory: [] }
  const { envelope, dropped } = check({ result: r })
  assert.equal(dropped, 1)
  assert.equal(envelope.findings.length, 0)
})

test('closed: number and merged from the event', () => {
  const closed = buildClosed({
    event: { ...event, action: 'closed', pull_request: { ...event.pull_request, merged: true, closed_at: '2026-10-02T13:00:00Z' } },
    projectKey: KEY,
  })
  assert.deepEqual(closed, {
    kind: 'closed', payload_version: 1, repository_id: '123456789', project_key: KEY,
    pr_number: 42, merged: true, closed_at: '2026-10-02T13:00:00Z',
  })
})

test('closed: an event without number or merged reports nothing', () => {
  assert.equal(buildClosed({ event: { repository: { id: 1 }, pull_request: { number: 42 } }, projectKey: KEY }), null)
  assert.equal(buildClosed({ event: { repository: { id: 1 } }, projectKey: KEY }), null)
})

test('classify: retry only on 5xx and 429', () => {
  assert.equal(classify(201), 'ok')
  assert.equal(classify(200), 'ok')
  assert.equal(classify(429), 'retry')
  assert.equal(classify(503), 'retry')
  for (const s of [400, 401, 403, 404, 409, 413, 422]) assert.equal(classify(s), 'final')
})

const respond = (status, body) => ({ status, json: async () => body })

test('send: retries a 503 then succeeds', async () => {
  const calls = []
  const replies = [respond(503, {}), respond(201, { status: 'created' })]
  const out = await send({ url: 'http://x', token: 't', body: '{}', delays: [0, 0], fetchImpl: async (_url, init) => { calls.push(init); return replies.shift() } })
  assert.equal(out.status, 201)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.Authorization, 'Bearer t')
})

test('send: never retries a 404 or a 403', async () => {
  for (const status of [404, 403, 422]) {
    let n = 0
    const out = await send({ url: 'http://x', token: 't', body: '{}', delays: [0, 0], fetchImpl: async () => { n++; return respond(status, { message: 'm' }) } })
    assert.equal(out.status, status)
    assert.equal(n, 1)
  }
})

test('send: gives up after the bounded retries', async () => {
  let n = 0
  const out = await send({ url: 'http://x', token: 't', body: '{}', delays: [0, 0], fetchImpl: async () => { n++; return respond(429, {}) } })
  assert.equal(out.status, 429)
  assert.equal(n, 3)
})

test('send: a network error is retried, then reported as status 0', async () => {
  let n = 0
  const out = await send({ url: 'http://x', token: 't', body: '{}', delays: [0], fetchImpl: async () => { n++; throw new Error('ECONNREFUSED') } })
  assert.equal(out.status, 0)
  assert.equal(n, 2)
})

test('report-to: https only, plain http on loopback for tests', () => {
  assert.equal(isAllowedUrl('https://example.com/ingest'), true)
  assert.equal(isAllowedUrl('http://127.0.0.1:8787/ingest'), true)
  assert.equal(isAllowedUrl('http://localhost:8787/'), true)
  assert.equal(isAllowedUrl('http://example.com/ingest'), false)
  assert.equal(isAllowedUrl('ftp://example.com'), false)
  assert.equal(isAllowedUrl('not a url'), false)
})
