import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SCHEMA, MAX_INLINE, MAX_PAYLOAD_ISSUES,
  buildPayload, codeSpan, commentableLines, computeScope, countFixed, createClient, describeFailure, encodeData, howToFix,
  parseData, parseInlineMarker, plainMessage, renderInline, renderInlineResolved, renderSummary, run, skipReason, summaryMarker,
} from '../comment.mjs'
import { isAllowedPullRequestUrl, savePullRequestUrl } from '../report.mjs'
import { startMockGitHub } from './mock-github.mjs'

const HEAD = 'a'.repeat(40)
const SCOPE = computeScope({ workflow: 'Accessibility', job: 'equall', path: '.', level: 'AA' })
// The fixture is a CLI diff result; the tests scan the pull request head unless they say not.
const fixture = () => ({ ...JSON.parse(readFileSync(new URL('./data/diff-result.json', import.meta.url), 'utf8')), head: HEAD })
const event = (over = {}) => ({
  action: 'synchronize',
  repository: { id: 1, full_name: 'acme/site' },
  pull_request: { number: 42, user: { login: 'octocat' }, head: { sha: HEAD, repo: { full_name: 'acme/site' } }, base: { ref: 'main' } },
  ...over,
})
const withHead = (sha) => event({ pull_request: { ...event().pull_request, head: { sha, repo: { full_name: 'acme/site' } } } })

// Patches where the fixture's line-bearing issues sit: Hero.tsx:14 is added, Footer.tsx:40 is not
// in the diff at all.
const PATCH_HERO = '@@ -10,5 +10,7 @@ export function Hero() {\n   return (\n     <section>\n       <div>\n-      <h1>Old</h1>\n+      <h1>New</h1>\n+      <img src="hero.png" />\n+      <p>Intro</p>\n     </section>'
const PATCH_FOOTER = '@@ -1,3 +1,4 @@\n import x from "y"\n+import z from "w"\n \n export const a = 1'
const FILES = [
  { filename: 'src/components/Hero.tsx', patch: PATCH_HERO },
  { filename: 'src/components/Footer.tsx', patch: PATCH_FOOTER },
  { filename: 'src/pages/signup.html', patch: '@@ -0,0 +1,2 @@\n+<form>\n+</form>' },
]

const silent = () => {
  const out = { notice: [], warning: [], debug: [] }
  return { out, log: { notice: (m) => out.notice.push(m), warning: (m) => out.warning.push(m), debug: (m) => out.debug.push(m) } }
}

async function withMock(opts, fn) {
  const gh = await startMockGitHub(opts)
  try {
    const client = createClient({ apiUrl: gh.url, token: 'ghs_test', repository: 'acme/site' })
    return await fn(gh, client)
  } finally {
    await gh.close()
  }
}

const runOnce = (client, result, over = {}) =>
  run({ result, event: event(), eventName: 'pull_request', actor: 'octocat', client, engineVersion: '0.3.4', pullRequestUrl: null, log: silent().log, scope: SCOPE, ...over })

// Wording guard: our own text never claims the code is accessible, clean or compliant. Rule
// messages come from the scanners and are removed before checking.
function assertNoClaims(body, result) {
  let text = body
  for (const i of [...result.new_issues, ...result.legacy_issues]) text = text.split(plainMessage(i)).join('')
  for (const word of ['accessible', 'clean', 'compliant', 'passed', 'all good']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text), `the comment must not say "${word}":\n${text}`)
  }
}

// Markdown that GitHub would turn live, outside a code span.
function liveMarkdown(body) {
  // HTML comments (the markers, the data block) are never rendered.
  const outside = body.replace(/<!--[\s\S]*?-->/g, '').replace(/(`+)[^`]*?\1/g, '')
  return {
    mention: /(^|[^\w`])@[\w-]+/.test(outside),
    image: /!\[/.test(outside),
    link: /\]\(https:\/\/(?!github\.com\/jsx-eslint|equallscan\.com)/.test(outside),
    autolink: /https?:\/\/(?!github\.com\/jsx-eslint|equallscan\.com)/.test(outside),
    html: /<(img|a|script)\b/i.test(outside),
  }
}

// ---------------------------------------------------------------------------------------------
// Diff mapping

test('patch: added and context lines on the right side are commentable, removed lines are not', () => {
  const lines = commentableLines(PATCH_HERO)
  assert.deepEqual([...lines].sort((a, b) => a - b), [10, 11, 12, 13, 14, 15, 16])
})

test('patch: several hunks, no-newline marker, missing patch', () => {
  const patch = '@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -50 +50,2 @@\n x\n+y\n\\ No newline at end of file'
  assert.deepEqual([...commentableLines(patch)], [1, 2, 50, 51])
  assert.equal(commentableLines(undefined).size, 0)
  assert.equal(commentableLines('Binary files differ').size, 0)
})

test('patch: a trailing newline adds no phantom line', () => {
  assert.deepEqual([...commentableLines('@@ -1,2 +1,3 @@\n a\n+b\n c\n')], [1, 2, 3])
  assert.deepEqual([...commentableLines('@@ -0,0 +1 @@\n+only\n\\ No newline at end of file\n')], [1])
})

// ---------------------------------------------------------------------------------------------
// Rendering

test('inline: what is wrong, who it affects, how to fix, and a scoped marker with the fingerprint', () => {
  const [hero, signup] = fixture().new_issues
  const body = renderInline(hero, SCOPE)
  assert.ok(body.startsWith(`<!-- equall:inline scope=${SCOPE} fp=a1b2c3d4e5f60718 -->`))
  assert.ok(body.includes('**New issue:** `img elements must have an alt prop'))
  assert.ok(!body.includes('(jsx-a11y/alt-text)`'), 'the rule id is not repeated in the message')
  assert.ok(body.includes('screen reader'))
  assert.ok(body.includes("[rule's guidance](https://github.com/jsx-eslint/"), 'no hint: the help link')
  assert.deepEqual(parseInlineMarker(body), { scope: SCOPE, fp: 'a1b2c3d4e5f60718', resolved: false })
  // With a fix hint: the hint, not the link.
  const fix = howToFix(signup)
  assert.ok(fix.startsWith('**How to fix:** `Fix any of the following:`'))
  assert.ok(fix.includes('- `Element does not have an explicit <label>`'))
  assert.ok(!fix.includes('dequeuniversity'))
})

test('inline: unknown criterion falls back to its name, no emoji, no severity', () => {
  const body = renderInline({ ...fixture().new_issues[0], wcag_criteria: ['2.4.6', '9.9.9', '<b>x</b>'] }, SCOPE)
  assert.ok(body.includes('Headings and Labels'))
  assert.ok(!body.includes('<b>'))
  assert.ok(!/critical|serious/i.test(body))
  assert.ok(!/\p{Extended_Pictographic}/u.test(body))
})

test('inline: an issue no longer found is marked, keeps the original, and is detected as resolved', () => {
  const original = renderInline(fixture().new_issues[0], SCOPE)
  const body = renderInlineResolved(original, SCOPE, 'a1b2c3d4e5f60718', HEAD)
  assert.deepEqual(parseInlineMarker(body), { scope: SCOPE, fp: 'a1b2c3d4e5f60718', resolved: true })
  assert.ok(body.includes('No longer found by the check on `aaaaaaa`'))
  assert.ok(body.includes('img elements must have an alt prop'))
  assert.equal((body.match(/<!-- equall:inline/g) ?? []).length, 1)
})

test('markdown injection: engine text cannot mention, link, embed or autolink', () => {
  const hostile = '@acme/everyone ![x](https://t.example/p.png) [login](https://phish.example) https://bare.example <img src=x>'
  const issue = {
    ...fixture().new_issues[1],
    message: `Form elements must have labels ${hostile} (label)`,
    suggestion: `Fix any of the following:\n  aria-label="${hostile}"\n  has \`backticks\` and | pipes`,
    file_path: 'src/@team/[a](https://phish.example).html',
  }
  const inline = renderInline(issue, SCOPE)
  const result = { ...fixture(), new_issues: [issue] }
  const summary = summaryFor(result)
  for (const [name, body] of [['inline', inline], ['summary', summary]]) {
    const live = liveMarkdown(body)
    for (const [kind, found] of Object.entries(live)) assert.equal(found, false, `${name}: live ${kind}\n${body}`)
  }
  // Backticks inside a span get a longer fence; pipes in a table cell are escaped.
  assert.equal(codeSpan('has `ticks`'), '`` has `ticks` ``')
  assert.equal(codeSpan('a ``b`` c'), '```a ``b`` c```')
  assert.equal(codeSpan('a|b', { table: true }), '`a\\|b`')
  assert.equal(codeSpan('`x`'), '`` `x` ``')
})

const summaryFor = (result, { listed = result.new_issues, fixed = 0, url = null, scanPath = '.', fixedAtLeast = false } = {}) => {
  const payload = buildPayload({ result, repository: 'acme/site', pullNumber: 42, headSha: HEAD, engineVersion: '0.3.4', fixed })
  return renderSummary({ result, payload, listed, pullRequestUrl: url, scope: SCOPE, scanPath, fixedAtLeast })
}

test('summary: verdict, the issues not shown inline, coverage and the uncounted lines', () => {
  const result = fixture()
  const body = summaryFor(result, { listed: result.new_issues.slice(1), fixed: 2 })
  assert.ok(body.startsWith(summaryMarker(SCOPE)))
  assert.ok(body.includes('### Equall\n'))
  assert.ok(body.includes('Equall found 3 new accessibility issues in this pull request. 2 issues fixed since the last check.'))
  assert.ok(body.includes('1 of them is commented on the changed lines.'))
  assert.ok(body.includes('<details><summary>2 issues not commented inline</summary>'))
  assert.ok(body.includes('| `src/pages/signup.html` | `Form elements must have labels` `label` | 4.1.2 |'))
  assert.ok(body.includes('| `src/components/Footer.tsx:40` |'))
  assert.ok(!body.includes('src/components/Hero.tsx:14'), 'an issue shown inline is not listed again')
  assert.ok(body.includes('2 changed files not statically testable (`src/styles/hero.css`, `src/lib/track.ts`).'))
  assert.ok(body.includes('2 existing issues in the changed files are not counted.'))
  assert.ok(body.includes('1 other new finding (to review, or best practice) is listed in the job summary'))
  assert.ok(!body.includes('click-events-have-key-events'), 'legacy issues are never listed')
  assert.ok(!body.includes('button-name'), 'review-only findings are never listed')
  assert.ok(body.includes('For agents: the data block in this comment lists the new issues of this check (schema equall.pr-check/v1).'))
  assert.ok(!body.includes('get_pull_request_check'), 'no tool that has not shipped')
  assert.ok(!body.includes('View on Equall'), 'no link without a page URL')
  assertNoClaims(body, result)
})

test('summary: singular forms, the scanned path in the header, and the page link', () => {
  const result = fixture()
  result.new_issues = result.new_issues.slice(0, 1)
  result.not_testable = ['a.css']
  const body = summaryFor(result, { listed: [], url: 'https://equallscan.com/dashboard/acme/site/pr/42', scanPath: './apps/web/' })
  assert.ok(body.includes('### Equall · `apps/web`'))
  assert.ok(body.includes('Equall found 1 new accessibility issue in this pull request.'))
  assert.ok(body.includes('1 changed file not statically testable (`a.css`).'))
  assert.ok(!body.includes('<details>'))
  assert.ok(body.includes('[View on Equall](https://equallscan.com/dashboard/acme/site/pr/42)'))
})

test('summary: resolved state never claims the code is fine and keeps the coverage line', () => {
  const result = { ...fixture(), new_issues: [] }
  const body = summaryFor(result, { listed: [], fixed: 3 })
  assert.ok(body.includes('No new accessibility issue found by static checks in this pull request. 3 issues fixed since the last check.'))
  assert.ok(body.includes('2 changed files not statically testable'))
  assert.ok(body.includes('Static checks only'))
  assert.ok(!body.includes('<details>'))
  assertNoClaims(body, result)
  assert.ok(summaryFor(result, { listed: [], fixed: 50, fixedAtLeast: true }).includes('At least 50 issues fixed since the last check.'))
})

test('summary: files that could not be analysed are named, and long lists are cut', () => {
  const result = { ...fixture(), new_issues: [], not_testable: ['1.css', '2.css', '3.css', '4.css', '5.css', '6.css', '7.css'] }
  result.unchecked = [{ scanner: 'eslint-jsx-a11y', file_path: 'src/X.tsx', reason: 'parse_error' }, { scanner: 'axe-core', file_path: 'src/X.tsx', reason: 'parse_error' }]
  const body = summaryFor(result, { listed: [] })
  assert.ok(body.includes('7 changed files not statically testable (`1.css`, `2.css`, `3.css`, `4.css`, `5.css` and 2 more).'))
  assert.ok(body.includes('1 changed file could not be analysed, so its findings are unknown (`src/X.tsx`).'))
})

// ---------------------------------------------------------------------------------------------
// Machine-readable data

test('payload: versioned schema, minimal fields, at most 50 issues', () => {
  const result = fixture()
  const p = buildPayload({ result, repository: 'acme/site', pullNumber: 42, headSha: HEAD, engineVersion: '0.3.4', fixed: 1 })
  assert.deepEqual(Object.keys(p), ['schema', 'repository', 'pull_request', 'head_sha', 'engine_version', 'counts', 'new_issues', 'truncated'])
  assert.equal(p.schema, SCHEMA)
  assert.equal(SCHEMA, 'equall.pr-check/v1')
  assert.deepEqual(p.counts, { new: 3, fixed: 1, legacy: 2, review_only: 1, not_testable: 2 })
  assert.deepEqual(p.new_issues[0], { fingerprint: 'a1b2c3d4e5f60718', file: 'src/components/Hero.tsx', line: 14, rule: 'jsx-a11y/alt-text', wcag: ['1.1.1'], severity: 'critical' })
  assert.equal(p.new_issues[1].line, null)
  assert.equal(p.truncated, false)
  const many = { ...result, new_issues: Array.from({ length: 70 }, (_, k) => ({ ...result.new_issues[0], fingerprint: `f${k}` })) }
  const big = buildPayload({ result: many, repository: 'acme/site', pullNumber: 42, headSha: HEAD, engineVersion: null, fixed: 0 })
  assert.equal(big.new_issues.length, MAX_PAYLOAD_ISSUES)
  assert.equal(big.counts.new, 70)
  assert.equal(big.truncated, true)
  assert.equal(big.engine_version, null)
  // Never the snippet, the message, the suggestion or a link.
  assert.ok(!/html_snippet|suggestion|help_url|message/.test(JSON.stringify(p)))
})

test('payload: round-trips through the summary and can never close its HTML comment', () => {
  const result = fixture()
  result.new_issues[0].file_path = 'evil--><img src=x>.tsx'
  const body = summaryFor(result)
  const data = parseData(body)
  assert.equal(data.new_issues[0].file, 'evil--><img src=x>.tsx')
  assert.ok(!encodeData(data).includes('-->'))
  assert.equal(parseData('<!-- equall:data {"schema":"other/v9"} -->'), null)
  assert.equal(parseData('<!-- equall:data {broken -->'), null)
})

test('fixed: issues of the previous check that are gone, unless their file could not be analysed', () => {
  const previous = { schema: SCHEMA, head_sha: 'b'.repeat(40), counts: { fixed: 0 }, truncated: false, new_issues: [
    { fingerprint: 'x', file: 'a.tsx' }, { fingerprint: 'y', file: 'b.tsx' }, { fingerprint: 'z', file: 'c.tsx' },
  ] }
  const args = { previous, sha: HEAD, current: new Set(['x']), unchecked: new Set() }
  assert.deepEqual(countFixed(args), { fixed: 2, atLeast: false })
  assert.deepEqual(countFixed({ ...args, unchecked: new Set(['c.tsx']) }), { fixed: 1, atLeast: false })
  assert.deepEqual(countFixed({ ...args, previous: null }), { fixed: 0, atLeast: false })
  // The previous list was cut at 50: a lower bound.
  assert.deepEqual(countFixed({ ...args, previous: { ...previous, truncated: true } }), { fixed: 2, atLeast: true })
  // A re-run on the same commit keeps the count it had, and its wording.
  const same = { ...previous, head_sha: HEAD, counts: { fixed: 4 } }
  assert.deepEqual(countFixed({ ...args, previous: same }), { fixed: 4, atLeast: false })
  assert.deepEqual(countFixed({ ...args, previous: same, previousBody: 'x At least 4 issues fixed since the last check.' }), { fixed: 4, atLeast: true })
})

// ---------------------------------------------------------------------------------------------
// Pull request page URL

test('page URL: https on equallscan.com or www.equallscan.com only, no credentials, no port', () => {
  assert.equal(isAllowedPullRequestUrl('https://equallscan.com/dashboard/acme/site/pr/42'), true)
  assert.equal(isAllowedPullRequestUrl('https://www.equallscan.com/dashboard/acme/site/pr/42'), true)
  for (const bad of [
    'https://app.equallscan.com/pr/42', 'http://equallscan.com/pr/42', 'https://equallscan.com.evil.com/pr', 'https://evilequallscan.com/pr',
    'https://user:pw@equallscan.com/pr', 'https://equallscan.com:8443/pr', 'javascript:alert(1)',
    'https://example.supabase.co/pr/42', '', null, 42, `https://equallscan.com/${'a'.repeat(3000)}`,
  ]) assert.equal(isAllowedPullRequestUrl(bad), false, String(bad).slice(0, 60))
})

test('page URL: saved for the comment step only from a successful response with a valid link', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'equall-'))
  const file = join(dir, 'url.txt')
  assert.equal(savePullRequestUrl({ status: 201, payload: { pull_request_url: 'https://evil.com/x' } }, file), false)
  assert.equal(savePullRequestUrl({ status: 500, payload: { pull_request_url: 'https://equallscan.com/x' } }, file), false)
  assert.equal(savePullRequestUrl({ status: 201, payload: {} }, file), false)
  assert.equal(existsSync(file), false)
  assert.equal(savePullRequestUrl({ status: 201, payload: { pull_request_url: 'https://equallscan.com/dashboard/w/r/pr/7' } }, file), true)
  assert.equal(readFileSync(file, 'utf8'), 'https://equallscan.com/dashboard/w/r/pr/7')
})

// ---------------------------------------------------------------------------------------------
// When it comments

test('skip: forks (also deleted ones), dependabot, other events and closed pull requests', () => {
  const pr = event().pull_request
  const fork = event({ pull_request: { ...pr, head: { sha: HEAD, repo: { full_name: 'someone/site' } } } })
  assert.equal(skipReason({ eventName: 'pull_request', event: fork, actor: 'someone' }).kind, 'notice')
  const deleted = event({ pull_request: { ...pr, head: { sha: HEAD, repo: null } } })
  assert.match(skipReason({ eventName: 'pull_request', event: deleted, actor: 'someone' }).message, /fork/)
  assert.equal(skipReason({ eventName: 'pull_request', event: event(), actor: 'dependabot[bot]' }).kind, 'notice')
  // Re-run by a person on a Dependabot pull request: the author still says so.
  const bump = event({ pull_request: { ...pr, user: { login: 'dependabot[bot]' } } })
  assert.match(skipReason({ eventName: 'pull_request', event: bump, actor: 'octocat' }).message, /Dependabot/)
  assert.equal(skipReason({ eventName: 'push', event: event(), actor: 'x' }).kind, 'debug')
  assert.equal(skipReason({ eventName: 'pull_request_target', event: event(), actor: 'x' }).kind, 'debug')
  for (const action of ['closed', 'edited', 'labeled']) assert.equal(skipReason({ eventName: 'pull_request', event: event({ action }), actor: 'x' }).kind, 'debug')
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) assert.equal(skipReason({ eventName: 'pull_request', event: event({ action }), actor: 'x' }), null)
})

test('skip: a fork makes no API call at all', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    const { out, log } = silent()
    const fork = event({ pull_request: { ...event().pull_request, head: { sha: HEAD, repo: { full_name: 'someone/site' } } } })
    const res = await runOnce(client, fixture(), { event: fork, actor: 'someone', log })
    assert.equal(res.skipped, true)
    assert.equal(gh.state.requests.length, 0)
    assert.match(out.notice[0], /fork/)
  })
})

test('permission: a 403 on the first write is the pull-requests: write warning', async () => {
  await withMock({ files: FILES, forceWriteStatus: 403 }, async (gh, client) => {
    await assert.rejects(runOnce(client, fixture()), (err) => {
      assert.equal(describeFailure(err).kind, 'warning')
      assert.match(describeFailure(err).message, /pull-requests: write/)
      return true
    })
    assert.equal(gh.state.requests.filter((r) => r.method !== 'GET').length, 1, 'stops after the first refused write')
  })
})

test('permission: a refused read is reported precisely, not as a permission problem', async () => {
  await withMock({ files: FILES, forceStatus: 404 }, async (_gh, client) => {
    await assert.rejects(runOnce(client, fixture()), (err) => {
      const { message } = describeFailure(err)
      assert.doesNotMatch(message, /pull-requests: write/)
      assert.match(message, /GET \/pulls\/42\/files, HTTP 404/)
      return true
    })
  })
  assert.match(describeFailure(new Error('boom')).message, /boom.*unaffected/)
})

test('nothing new and no previous comment: no comment at all', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    const res = await runOnce(client, { ...fixture(), new_issues: [] })
    assert.equal(res.summary, 'none')
    assert.ok(gh.state.requests.every((r) => r.method === 'GET'))
  })
})

// ---------------------------------------------------------------------------------------------
// Against the mock API: inline, summary, idempotency, resolution

test('first run: one review with the issue on a diff line, one summary listing the others', async () => {
  await withMock({ files: FILES, pageSize: 1 }, async (gh, client) => {
    const res = await runOnce(client, fixture())
    assert.deepEqual(res, { skipped: false, posted: 1, marked: 0, summary: 'created' })
    const reviews = gh.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reviews'))
    assert.equal(reviews.length, 1)
    assert.equal(reviews[0].body.event, 'COMMENT')
    assert.equal(reviews[0].body.commit_id, HEAD)
    assert.deepEqual(reviews[0].body.comments.map((c) => [c.path, c.line, c.side]), [['src/components/Hero.tsx', 14, 'RIGHT']])
    assert.equal(reviews[0].auth, 'Bearer ghs_test')
    assert.equal(gh.state.issueComments.length, 1)
    const summary = gh.state.issueComments[0].body
    assert.ok(summary.includes('Equall found 3 new accessibility issues'))
    assert.ok(summary.includes('`src/components/Footer.tsx:40`'), 'a line outside the diff goes to the summary')
    assert.ok(summary.includes('`src/pages/signup.html`'), 'an issue without a line goes to the summary')
    // Pagination: files were served one per page.
    assert.equal(gh.state.requests.filter((r) => r.path.endsWith('/files')).length, 3)
  })
})

test('re-run on the same commit: no duplicate inline comment, summary untouched', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    await runOnce(client, fixture())
    const before = gh.state.requests.length
    const res = await runOnce(client, fixture())
    assert.deepEqual(res, { skipped: false, posted: 0, marked: 0, summary: 'unchanged' })
    assert.ok(gh.state.requests.slice(before).every((r) => r.method === 'GET'))
    assert.equal(gh.state.reviewComments.length, 1)
    assert.equal(gh.state.issueComments.length, 1)
  })
})

test('later run with nothing new: summary updated to the resolved state, inline comment marked', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    await runOnce(client, fixture())
    const next = 'c'.repeat(40)
    gh.state.prHead = next
    const res = await runOnce(client, { ...fixture(), head: next, new_issues: [] }, { event: withHead(next) })
    assert.deepEqual(res, { skipped: false, posted: 0, marked: 1, summary: 'updated' })
    assert.equal(gh.state.issueComments.length, 1, 'updated, never a second summary')
    const summary = gh.state.issueComments[0].body
    assert.ok(summary.includes('No new accessibility issue found by static checks in this pull request. 3 issues fixed since the last check.'))
    assert.deepEqual(parseData(summary).counts, { new: 0, fixed: 3, legacy: 2, review_only: 1, not_testable: 2 })
    assert.equal(parseData(summary).head_sha, next)
    assert.deepEqual(parseInlineMarker(gh.state.reviewComments[0].body), { scope: SCOPE, fp: 'a1b2c3d4e5f60718', resolved: true })
    assertNoClaims(summary, fixture())
    // The issue comes back: the same inline comment is restored, not duplicated.
    const back = await runOnce(client, { ...fixture(), head: next }, { event: withHead(next) })
    assert.equal(back.posted, 0)
    assert.equal(gh.state.reviewComments.length, 1)
    assert.deepEqual(parseInlineMarker(gh.state.reviewComments[0].body), { scope: SCOPE, fp: 'a1b2c3d4e5f60718', resolved: false })
  })
})

test('overflow: at most 10 inline comments, the rest in the summary', async () => {
  const lines = Array.from({ length: 14 }, (_, k) => `+line ${k}`).join('\n')
  const files = [{ filename: 'src/Big.tsx', patch: `@@ -0,0 +1,14 @@\n${lines}` }]
  const result = { ...fixture(), new_issues: Array.from({ length: 12 }, (_, k) => ({ ...fixture().new_issues[0], file_path: 'src/Big.tsx', line: k + 1, fingerprint: `fp${k}` })) }
  await withMock({ files }, async (gh, client) => {
    const res = await runOnce(client, result)
    assert.equal(res.posted, MAX_INLINE)
    const summary = gh.state.issueComments[0].body
    assert.ok(summary.includes('Equall found 12 new accessibility issues'))
    assert.ok(summary.includes('10 of them are commented on the changed lines.'))
    assert.ok(summary.includes('2 issues not commented inline'))
    assert.ok(summary.includes('`src/Big.tsx:11`') && summary.includes('`src/Big.tsx:12`'))
  })
})

test('authors: a person or another bot carrying our markers is ignored', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    const person = { login: 'octocat', type: 'User' }
    const otherBot = { login: 'some-app[bot]', type: 'Bot' }
    gh.state.issueComments.push({ id: 1, user: otherBot, body: `${summaryMarker(SCOPE)}\nfake` })
    gh.state.reviewComments.push({ id: 2, user: person, path: 'src/components/Hero.tsx', line: 14, body: `<!-- equall:inline scope=${SCOPE} fp=a1b2c3d4e5f60718 -->` })
    gh.state.reviewComments.push({ id: 3, user: otherBot, path: 'src/components/Hero.tsx', line: 14, body: `<!-- equall:inline scope=${SCOPE} fp=a1b2c3d4e5f60718 -->` })
    const res = await runOnce(client, fixture())
    assert.equal(res.posted, 1, 'the foreign inline markers do not suppress the comment')
    assert.equal(res.summary, 'created')
    assert.equal(gh.state.issueComments[0].body, `${summaryMarker(SCOPE)}\nfake`, 'never edited')
  })
})

test('authors: with a token that can read /user, its own comments are recognised', async () => {
  await withMock({ files: FILES, userLogin: 'acme-ci', botLogin: 'acme-ci' }, async (gh, client) => {
    await runOnce(client, fixture())
    const res = await runOnce(client, fixture())
    assert.deepEqual(res, { skipped: false, posted: 0, marked: 0, summary: 'unchanged' })
    assert.equal(gh.state.issueComments.length, 1)
  })
})

test('scopes: two jobs on one pull request keep separate comments', async () => {
  const web = computeScope({ workflow: 'Accessibility', job: 'equall', path: 'apps/web', level: 'AA' })
  const docs = computeScope({ workflow: 'Accessibility', job: 'equall', path: './apps/docs/', level: 'AA' })
  assert.notEqual(web, docs)
  assert.equal(computeScope({ workflow: 'W', job: 'j', path: './x/', level: 'AA' }), computeScope({ workflow: 'W', job: 'j', path: 'x', level: 'AA' }))
  assert.notEqual(computeScope({ workflow: 'W', job: 'j', path: '.', level: 'AA' }), computeScope({ workflow: 'W', job: 'j', path: '.', level: 'AAA' }))
  await withMock({ files: FILES }, async (gh, client) => {
    await runOnce(client, fixture(), { scope: web, scanPath: 'apps/web' })
    await runOnce(client, fixture(), { scope: docs, scanPath: 'apps/docs' })
    assert.equal(gh.state.issueComments.length, 2, 'one summary per scope')
    assert.equal(gh.state.reviewComments.length, 2, 'each scope comments its own issue')
    assert.ok(gh.state.issueComments[0].body.includes('### Equall · `apps/web`'))
    assert.ok(gh.state.issueComments[1].body.includes('### Equall · `apps/docs`'))
    // One scope finding nothing new resolves only its own comments.
    const res = await runOnce(client, { ...fixture(), new_issues: [] }, { scope: docs, scanPath: 'apps/docs' })
    assert.equal(res.marked, 1)
    assert.ok(gh.state.issueComments[0].body.includes('Equall found 3 new'), 'the other scope is untouched')
    assert.ok(gh.state.issueComments[1].body.includes('No new accessibility issue found'))
    assert.equal(parseInlineMarker(gh.state.reviewComments[0].body).resolved, false)
    assert.equal(parseInlineMarker(gh.state.reviewComments[1].body).resolved, true)
  })
})

test('writes are independent: a PATCH answering 404 mid-loop does not stop the others', async () => {
  await withMock({ files: FILES, failures: [{ method: 'PATCH', match: /\/pulls\/comments\/1$/, status: 404 }] }, async (gh, client) => {
    const bot = { login: 'github-actions[bot]', type: 'Bot' }
    for (const [id, fp] of [[1, 'gone1'], [2, 'gone2']]) {
      gh.state.reviewComments.push({ id, user: bot, path: 'src/components/Hero.tsx', line: 12, body: `<!-- equall:inline scope=${SCOPE} fp=${fp} -->\nold` })
    }
    const { out, log } = silent()
    const res = await runOnce(client, fixture(), { log })
    assert.equal(res.marked, 1)
    assert.equal(res.posted, 1)
    assert.equal(res.summary, 'created')
    assert.equal(out.warning.length, 1)
    assert.match(out.warning[0], /mark an inline comment.*HTTP 404/)
    assert.doesNotMatch(out.warning[0], /pull-requests: write/)
  })
})

test('outdated inline comment (line gone after a push): the issue is commented again', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    gh.state.reviewComments.push({ id: 5, user: { login: 'github-actions[bot]' }, path: 'src/components/Hero.tsx', line: null, original_line: 9, body: `<!-- equall:inline scope=${SCOPE} fp=a1b2c3d4e5f60718 -->\nold` })
    const res = await runOnce(client, fixture())
    assert.equal(res.posted, 1)
    assert.ok(gh.state.issueComments[0].body.includes('1 of them is commented on the changed lines.'))
  })
})

test('review created but answered 502: no duplicate in the one-by-one fallback', async () => {
  await withMock({ files: FILES, reviewThenFail: 502 }, async (gh, client) => {
    const res = await runOnce(client, fixture())
    assert.equal(res.posted, 1)
    assert.equal(gh.state.reviewComments.length, 1)
    assert.equal(gh.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/pulls/42/comments')).length, 0)
  })
})

test('a rejected review falls back to single comments; the ones still refused go to the summary', async () => {
  await withMock({ files: FILES, failures: [
    { method: 'POST', match: /\/reviews$/, status: 422 },
    { method: 'POST', match: /\/pulls\/42\/comments$/, status: 422 },
  ] }, async (gh, client) => {
    const res = await runOnce(client, fixture())
    assert.equal(res.posted, 0)
    assert.ok(gh.state.issueComments[0].body.includes('`src/components/Hero.tsx:14`'))
    assert.ok(!gh.state.issueComments[0].body.includes('commented on the changed lines'))
  })
})

test('line drift: a merge-commit scan comments nothing inline and names the scanned commit', async () => {
  const merge = 'd'.repeat(40)
  await withMock({ files: FILES }, async (gh, client) => {
    const { out, log } = silent()
    const res = await runOnce(client, { ...fixture(), head: merge }, { log })
    assert.equal(res.posted, 0)
    assert.equal(gh.state.reviewComments.length, 0)
    const summary = gh.state.issueComments[0].body
    assert.ok(summary.includes('`src/components/Hero.tsx:14`'), 'listed instead')
    assert.ok(summary.includes('Checked commit `ddddddd`'))
    assert.equal(parseData(summary).head_sha, merge)
    assert.match(out.notice[0], /pull_request\.head\.sha/)
  })
})

test('stale check: the pull request moved on, nothing is written', async () => {
  await withMock({ files: FILES }, async (gh, client) => {
    gh.state.prHead = 'e'.repeat(40)
    const { out, log } = silent()
    const res = await runOnce(client, fixture(), { log })
    assert.equal(res.skipped, true)
    assert.ok(gh.state.requests.every((r) => r.method === 'GET'))
    assert.match(out.notice[0], /changed since this check/)
  })
})

test('client: never sends the token to another origin, never follows redirects', async () => {
  let called = false
  const client = createClient({ apiUrl: 'https://api.github.com', token: 't', repository: 'a/b', fetchImpl: async () => { called = true } })
  await assert.rejects(client.call('GET', 'https://evil.example/repos/a/b/pulls/1/files'), /outside the API/)
  assert.equal(called, false)
  let init
  const spy = createClient({ apiUrl: 'https://api.github.com', token: 't', repository: 'a/b', fetchImpl: async (_u, i) => { init = i; return { status: 200, json: async () => [] } } })
  await spy.call('GET', '/pulls/1/files')
  assert.equal(init.redirect, 'error')
})

// ---------------------------------------------------------------------------------------------
// Sample output, printed with EQUALL_PRINT_SAMPLES=1 for review

test('sample: fixture rendering', { skip: !process.env.EQUALL_PRINT_SAMPLES }, () => {
  const result = fixture()
  console.log(renderInline(result.new_issues[0], SCOPE))
  console.log('\n-----\n')
  console.log(summaryFor(result, { listed: result.new_issues.slice(1), url: 'https://equallscan.com/dashboard/acme/site/pr/42' }))
})
