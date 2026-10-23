// Comments on a pull request with what the change introduced, and only that.
//
// Two layers, both kept quiet on purpose:
//   - one inline review comment per new issue, on its line, when that line is part of the
//     pull request diff (at most MAX_INLINE per run, never twice for the same issue);
//   - one summary comment, found again and updated through a hidden marker. It is created
//     only when the change introduces at least one new issue; once it exists, later runs keep
//     it current, down to the state where nothing new is found.
//
// Every marker carries a scope (workflow, job, path and level), so several jobs commenting on
// the same pull request each keep their own comments.
//
// Called by action.yml when `comment` is on. Like report.mjs, it is accessory: it always exits
// 0 and speaks through workflow commands, so the check's own result never depends on it.
//
// Usage: node comment.mjs <result.json>

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isAllowedUrl, isAllowedPullRequestUrl } from './report.mjs'

export const SUMMARY_MARKER = '<!-- equall:pr-comment'
export const DEFAULT_LOGIN = 'github-actions[bot]'
export const SCHEMA = 'equall.pr-check/v1'
export const MAX_INLINE = 10
export const MAX_PAYLOAD_ISSUES = 50
const MAX_LISTED = 100
const MAX_FILES_LISTED = 5
const MAX_PAGES = 30
const COMMENT_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review']
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor']
const SHA = /^[0-9a-f]{40}$/
const FINGERPRINT = /^[A-Za-z0-9_-]{1,64}$/
const CRITERION = /^\d\.\d{1,2}\.\d{1,2}$/

// WCAG 2.2 success criteria, levels A and AA: the fallback "why it matters" line.
export const WCAG_NAMES = {
  '1.1.1': 'Non-text Content', '1.2.1': 'Audio-only and Video-only (Prerecorded)', '1.2.2': 'Captions (Prerecorded)',
  '1.2.3': 'Audio Description or Media Alternative (Prerecorded)', '1.2.4': 'Captions (Live)', '1.2.5': 'Audio Description (Prerecorded)',
  '1.3.1': 'Info and Relationships', '1.3.2': 'Meaningful Sequence', '1.3.3': 'Sensory Characteristics', '1.3.4': 'Orientation',
  '1.3.5': 'Identify Input Purpose', '1.4.1': 'Use of Color', '1.4.2': 'Audio Control', '1.4.3': 'Contrast (Minimum)',
  '1.4.4': 'Resize Text', '1.4.5': 'Images of Text', '1.4.10': 'Reflow', '1.4.11': 'Non-text Contrast', '1.4.12': 'Text Spacing',
  '1.4.13': 'Content on Hover or Focus', '2.1.1': 'Keyboard', '2.1.2': 'No Keyboard Trap', '2.1.4': 'Character Key Shortcuts',
  '2.2.1': 'Timing Adjustable', '2.2.2': 'Pause, Stop, Hide', '2.3.1': 'Three Flashes or Below Threshold', '2.4.1': 'Bypass Blocks',
  '2.4.2': 'Page Titled', '2.4.3': 'Focus Order', '2.4.4': 'Link Purpose (In Context)', '2.4.5': 'Multiple Ways',
  '2.4.6': 'Headings and Labels', '2.4.7': 'Focus Visible', '2.4.11': 'Focus Not Obscured (Minimum)', '2.5.1': 'Pointer Gestures',
  '2.5.2': 'Pointer Cancellation', '2.5.3': 'Label in Name', '2.5.4': 'Motion Actuation', '2.5.7': 'Dragging Movements',
  '2.5.8': 'Target Size (Minimum)', '3.1.1': 'Language of Page', '3.1.2': 'Language of Parts', '3.2.1': 'On Focus', '3.2.2': 'On Input',
  '3.2.3': 'Consistent Navigation', '3.2.4': 'Consistent Identification', '3.2.6': 'Consistent Help', '3.3.1': 'Error Identification',
  '3.3.2': 'Labels or Instructions', '3.3.3': 'Error Suggestion', '3.3.4': 'Error Prevention (Legal, Financial, Data)',
  '3.3.7': 'Redundant Entry', '3.3.8': 'Accessible Authentication (Minimum)', '4.1.2': 'Name, Role, Value', '4.1.3': 'Status Messages',
}

// Who is affected, for the criteria static checks report most often. One sentence each.
export const WHO_IT_AFFECTS = {
  '1.1.1': 'People using a screen reader may get no description of this content, or only its file name.',
  '1.3.1': 'Screen reader users may miss the structure sighted users see, such as which label goes with which field.',
  '1.4.3': 'People with low vision may not be able to read this text against its background.',
  '2.1.1': 'Keyboard users may not be able to reach or use this control.',
  '2.4.1': 'Keyboard and screen reader users may have to go through repeated content before reaching the main content.',
  '2.4.2': 'Screen reader users, and anyone switching tabs, may not know what this page is.',
  '2.4.3': 'Keyboard users may move through the page in a confusing order.',
  '2.4.4': 'Screen reader users may not know where this link goes.',
  '2.4.6': 'People may not be able to tell sections or fields apart by their headings and labels.',
  '2.4.7': 'Keyboard users may not see which element has focus.',
  '2.5.3': 'Voice control users may not be able to activate this control by saying the label they see.',
  '3.1.1': 'Screen readers may read this page with the wrong pronunciation.',
  '3.3.1': 'People who cannot see the error styling may not know that, or why, a field is invalid.',
  '3.3.2': 'People may not know what to enter in this field.',
  '4.1.2': 'Screen reader users may not hear what this element is or what it does.',
  '4.1.3': 'Screen reader users may not hear this status update.',
}


// ---------------------------------------------------------------------------------------------
// Scope

const normalizePath = (p) => {
  const t = String(p ?? '').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return t === '' ? '.' : t
}

// A short id for one commenting job: two jobs on the same pull request (a monorepo `path`, a
// matrix over `level`) never touch each other's comments.
export function computeScope({ workflow, job, path, level }) {
  const key = JSON.stringify([String(workflow ?? ''), String(job ?? ''), normalizePath(path), String(level ?? '')])
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

// ---------------------------------------------------------------------------------------------
// Rendering
//
// Text from the engines (messages, fix hints, file paths, rule ids) is never trusted as
// Markdown: a fix hint can quote attribute values written by the pull request's author. It is
// always rendered inside a code span, where GitHub shows HTML, links, images and @mentions as
// plain text. Only this file's own text and validated links are Markdown.

// A code span around any text. The fence is longer than any backtick run inside it; in a
// table cell, the pipe is escaped (GitHub honours `\|` inside code spans in tables).
export function codeSpan(s, { table = false } = {}) {
  let t = String(s ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (table) t = t.replace(/\|/g, '\\|')
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(longest + 1)
  const pad = t === '' || t.startsWith('`') || t.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${t}${pad}${fence}`
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const criteriaOf = (issue) => (Array.isArray(issue.wcag_criteria) ? issue.wcag_criteria.filter((c) => CRITERION.test(c)) : [])

// The CLI appends the rule id to the message; the comment shows the rule on its own.
export function plainMessage(issue) {
  const msg = String(issue.message ?? '').trim()
  const suffix = ` (${issue.scanner_rule_id})`
  return msg.endsWith(suffix) ? msg.slice(0, -suffix.length) : msg
}

function safeLink(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.href.replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return null
  }
}

export function whyItMatters(criteria) {
  const list = (Array.isArray(criteria) ? criteria : []).filter((c) => CRITERION.test(c))
  for (const c of list) if (WHO_IT_AFFECTS[c]) return WHO_IT_AFFECTS[c]
  const named = list.map((c) => (WCAG_NAMES[c] ? `${c} ${WCAG_NAMES[c]}` : c))
  return named.length > 0 ? `This affects WCAG ${named.join(', ')}.` : null
}

// "How to fix": the CLI's hint when it has a real one, otherwise the rule's guidance link.
export function howToFix(issue) {
  const hint = typeof issue.suggestion === 'string' ? issue.suggestion.trim() : ''
  if (hint !== '' && hint !== 'Auto-fixable') {
    const [lead, ...rest] = hint.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const bullets = rest.slice(0, 4).map((l) => `- ${codeSpan(l)}`)
    if (rest.length > 4) bullets.push('- …')
    return [`**How to fix:** ${codeSpan(lead)}`, ...bullets].join('\n')
  }
  const link = safeLink(issue.help_url)
  return link ? `**How to fix:** see the [rule's guidance](${link}).` : null
}

export const summaryMarker = (scope) => `${SUMMARY_MARKER} scope=${scope} -->`
const inlineMarker = (scope, fp, resolved = false) => `<!-- equall:inline scope=${scope} fp=${fp}${resolved ? ' state=resolved' : ''} -->`

export function renderInline(issue, scope) {
  const criteria = criteriaOf(issue).map((c) => (WCAG_NAMES[c] ? `WCAG ${c} ${WCAG_NAMES[c]}` : `WCAG ${c}`))
  return [
    inlineMarker(scope, issue.fingerprint),
    `**New issue:** ${codeSpan(plainMessage(issue))}`,
    '',
    whyItMatters(issue.wcag_criteria),
    '',
    howToFix(issue),
    '',
    `<sub>Equall · new in this pull request · ${codeSpan(issue.scanner_rule_id)}${criteria.length ? ` · ${criteria.join(', ')}` : ''}</sub>`,
  ]
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

// An inline comment whose issue the latest check no longer finds: kept, marked, never deleted.
export function renderInlineResolved(previousBody, scope, fp, sha) {
  const original = String(previousBody).replace(/^<!-- equall:inline[^>]*-->\n?/, '')
  return [
    inlineMarker(scope, fp, true),
    `No longer found by the check on ${codeSpan(String(sha).slice(0, 7))}.`,
    '',
    '<details><summary>Previous comment</summary>',
    '',
    original,
    '',
    '</details>',
  ].join('\n')
}

// Parses an Equall inline comment marker: { scope, fp, resolved } or null.
export function parseInlineMarker(body) {
  const m = /^<!-- equall:inline scope=([0-9a-f]{8}) fp=([A-Za-z0-9_-]{1,64})( state=resolved)? -->/.exec(String(body ?? ''))
  return m ? { scope: m[1], fp: m[2], resolved: Boolean(m[3]) } : null
}

function fileList(files) {
  const shown = files.slice(0, MAX_FILES_LISTED).map((f) => codeSpan(f)).join(', ')
  return files.length > MAX_FILES_LISTED ? `${shown} and ${files.length - MAX_FILES_LISTED} more` : shown
}

// The JSON goes inside an HTML comment: `<`, `>` and `&` are escaped so it can never close it.
export function encodeData(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

export function parseData(body) {
  const m = /<!-- equall:data (\{.*?\}) -->/s.exec(String(body ?? ''))
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    return data && data.schema === SCHEMA ? data : null
  } catch {
    return null
  }
}

export function buildPayload({ result, repository, pullNumber, headSha, engineVersion, fixed }) {
  const s = result.summary ?? {}
  return {
    schema: SCHEMA,
    repository,
    pull_request: pullNumber,
    head_sha: headSha,
    engine_version: engineVersion || null,
    counts: {
      new: result.new_issues.length,
      fixed,
      legacy: s.legacy_count ?? result.legacy_issues?.length ?? 0,
      review_only: s.new_review_only_count ?? result.new_review_only?.length ?? 0,
      not_testable: s.not_testable_count ?? result.not_testable?.length ?? 0,
    },
    new_issues: result.new_issues.slice(0, MAX_PAYLOAD_ISSUES).map((i) => ({
      fingerprint: typeof i.fingerprint === 'string' && i.fingerprint !== '' ? i.fingerprint : null,
      file: i.file_path,
      line: Number.isInteger(i.line) && i.line > 0 ? i.line : null,
      rule: i.scanner_rule_id,
      wcag: Array.isArray(i.wcag_criteria) ? i.wcag_criteria : [],
      severity: SEVERITIES.includes(i.severity) ? i.severity : null,
    })),
    truncated: result.new_issues.length > MAX_PAYLOAD_ISSUES,
  }
}

// `listed`: the new issues not shown inline. `pullRequestUrl`: validated, or null.
// `fixedAtLeast`: the previous list was cut, so the fixed count is a lower bound.
export function renderSummary({ result, payload, listed, pullRequestUrl, scope, scanPath = '.', fixedAtLeast = false }) {
  const n = payload.counts.new
  const fixed = payload.counts.fixed
  const fixedText = fixed > 0 ? ` ${fixedAtLeast ? 'At least ' : ''}${plural(fixed, 'issue', 'issues')} fixed since the last check.` : ''
  const path = normalizePath(scanPath)
  const lines = [summaryMarker(scope), `### Equall${path !== '.' ? ` · ${codeSpan(path)}` : ''}`, '']
  if (n > 0) {
    lines.push(`Equall found ${plural(n, 'new accessibility issue', 'new accessibility issues')} in this pull request.${fixedText}`)
    const inline = n - listed.length
    if (inline > 0) lines.push('', `${inline} of them ${inline === 1 ? 'is' : 'are'} commented on the changed lines.`)
  } else {
    lines.push(`No new accessibility issue found by static checks in this pull request.${fixedText}`)
  }

  if (listed.length > 0) {
    const rows = listed.slice(0, MAX_LISTED).map((i) => {
      const where = Number.isInteger(i.line) && i.line > 0 ? `${i.file_path}:${i.line}` : i.file_path
      return `| ${codeSpan(where, { table: true })} | ${codeSpan(plainMessage(i), { table: true })} ${codeSpan(i.scanner_rule_id, { table: true })} | ${criteriaOf(i).join(', ')} |`
    })
    if (listed.length > MAX_LISTED) rows.push(`| … | ${listed.length - MAX_LISTED} more in the job summary | |`)
    lines.push(
      '',
      `<details><summary>${plural(listed.length, 'issue', 'issues')} not commented inline</summary>`,
      '',
      '| Location | Issue | WCAG |',
      '|---|---|---|',
      ...rows,
      '',
      '</details>',
    )
  }

  const notes = []
  const notTestable = result.not_testable ?? []
  if (notTestable.length > 0) {
    notes.push(`${plural(notTestable.length, 'changed file', 'changed files')} not statically testable (${fileList(notTestable)}).`)
  }
  const unchecked = [...new Set((result.unchecked ?? []).map((u) => u.file_path))]
  if (unchecked.length > 0) {
    notes.push(`${plural(unchecked.length, 'changed file', 'changed files')} could not be analysed, so ${unchecked.length === 1 ? 'its' : 'their'} findings are unknown (${fileList(unchecked)}).`)
  }
  const legacy = payload.counts.legacy
  if (legacy > 0) notes.push(`${plural(legacy, 'existing issue', 'existing issues')} in the changed files ${legacy === 1 ? 'is' : 'are'} not counted.`)
  const uncounted = (result.summary?.new_review_only_count ?? 0) + (result.summary?.new_advisory_count ?? 0)
  if (uncounted > 0) notes.push(`${plural(uncounted, 'other new finding', 'other new findings')} (to review, or best practice) ${uncounted === 1 ? 'is' : 'are'} listed in the job summary, not counted here.`)
  if (notes.length > 0) lines.push('', ...notes)

  if (pullRequestUrl) lines.push('', `[View on Equall](${pullRequestUrl})`)
  lines.push(
    '',
    `<sub>Checked commit ${codeSpan(String(payload.head_sha).slice(0, 7))}. Static checks only: contrast, focus order and other rendered checks need their own test. ` +
      `For agents: the data block in this comment lists the new issues of this check (schema ${SCHEMA}).</sub>`,
    '',
    `<!-- equall:data ${encodeData(payload)} -->`,
  )
  return lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n')
}

// ---------------------------------------------------------------------------------------------
// Diff mapping

// Lines of the new file (RIGHT side) a review comment can be attached to: added (`+`) and
// context (` `) lines inside the hunks of a unified patch, as the pull request files API
// returns it. Anything else (removed lines, `\ No newline at end of file`, a trailing empty
// line) is not a line of the new file.
export function commentableLines(patch) {
  const lines = new Set()
  if (typeof patch !== 'string') return lines
  let right = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      right = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk || !(raw.startsWith('+') || raw.startsWith(' '))) continue
    lines.add(right)
    right++
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// GitHub API

export class ApiError extends Error {
  constructor(status, message, context = '') {
    super(message)
    this.status = status
    this.context = context
  }
}

export function createClient({ apiUrl, token, repository, fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, '')
  const origin = new URL(base).origin
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'equall-action',
  }
  async function request(method, url, body, context) {
    // The token only goes back to the API it came from, and never follows a redirect.
    if (new URL(url).origin !== origin) throw new ApiError(0, 'refusing to follow a link outside the API', context)
    let res
    try {
      res = await fetchImpl(url, { method, headers, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      throw new ApiError(0, err instanceof Error ? err.message : String(err), context)
    }
    const data = await res.json().catch(() => null)
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, data?.message ?? `HTTP ${res.status}`, context)
    return { data, link: res.headers?.get?.('link') ?? null }
  }
  // Paths are relative to the repository; absolute URLs only come from pagination links.
  const call = (method, pathOrUrl, body) =>
    request(method, pathOrUrl.startsWith('http') ? pathOrUrl : `${base}/repos/${repository}${pathOrUrl}`, body, `${method} ${pathOrUrl.split('?')[0]}`)
  async function paginate(path) {
    const items = []
    let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const { data, link } = await call('GET', next)
      if (Array.isArray(data)) items.push(...data)
      next = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null
    }
    return items
  }
  // The token's own login, when the API tells it (a personal token). The workflow token
  // cannot read /user: null, and the caller falls back to the Actions bot.
  async function whoami() {
    try {
      const { data } = await request('GET', `${base}/user`, undefined, 'GET /user')
      return typeof data?.login === 'string' ? data.login : null
    } catch {
      return null
    }
  }
  return { call, paginate, whoami }
}

// Writes are independent: one refused write is logged and the others still run. A 401 or 403
// on the very first write means the token cannot write at all: that one stops the run.
function createWriter(client, log) {
  let first = true
  return async function write(what, method, path, body, { quiet = false } = {}) {
    const isFirst = first
    first = false
    try {
      return { ok: true, data: (await client.call(method, path, body)).data }
    } catch (err) {
      if (isFirst && (err.status === 401 || err.status === 403)) {
        err.permission = true
        throw err
      }
      if (!quiet) log.warning(`Could not ${what} (${err.status ? `HTTP ${err.status}: ` : ''}${err.message}). The check itself is unaffected.`)
      return { ok: false, err }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Orchestration

const isDependabot = (login) => login === 'dependabot[bot]'

// Why commenting is skipped, or null. `kind` picks the workflow command.
export function skipReason({ eventName, event, actor }) {
  if (eventName !== 'pull_request') return { kind: 'debug', message: `Not a pull_request event (${eventName}): no comment.` }
  if (!COMMENT_ACTIONS.includes(event.action)) return { kind: 'debug', message: `Pull request ${event.action}: no comment.` }
  const pr = event.pull_request
  if (!pr || !Number.isInteger(pr.number) || !SHA.test(pr.head?.sha ?? '')) return { kind: 'debug', message: 'No pull request in the event: no comment.' }
  // A deleted fork has no head repository left: still a fork.
  if (!pr.head.repo || pr.head.repo.full_name !== event.repository?.full_name) {
    return { kind: 'notice', message: 'Pull request from a fork: its token cannot comment, so the results are in the job summary only.' }
  }
  if (isDependabot(actor) || isDependabot(pr.user?.login)) return { kind: 'notice', message: 'Dependabot pull requests get a read-only token: no comment.' }
  return null
}

// Issues the previous check listed that this one no longer finds. A re-run on the same commit
// keeps the previous count; a file that could not be analysed this time is not counted as
// fixed. When the previous list was cut at its limit, the count is a lower bound.
export function countFixed({ previous, previousBody = '', sha, current, unchecked }) {
  if (!previous) return { fixed: 0, atLeast: false }
  if (previous.head_sha === sha) {
    const fixed = Number.isInteger(previous.counts?.fixed) ? previous.counts.fixed : 0
    return { fixed, atLeast: fixed > 0 && /At least \d+ issues? fixed/.test(previousBody) }
  }
  const gone = (previous.new_issues ?? []).filter((i) => i.fingerprint && !current.has(i.fingerprint) && !unchecked.has(i.file))
  return { fixed: gone.length, atLeast: previous.truncated === true }
}

// Equall's live inline comments of this scope, by fingerprint. An outdated comment (its line
// is gone after a push) no longer shows the issue: it counts as absent.
function inlineByFingerprint(comments, ours, scope) {
  const map = new Map()
  for (const c of comments) {
    if (!ours(c) || c.line === null || c.line === undefined) continue
    const marker = parseInlineMarker(c.body)
    if (marker && marker.scope === scope && !map.has(marker.fp)) map.set(marker.fp, { ...marker, comment: c })
  }
  return map
}

export async function run({ result, event, eventName, actor, client, engineVersion, pullRequestUrl, log, scope, scanPath = '.' }) {
  const skip = skipReason({ eventName, event, actor })
  if (skip) {
    log[skip.kind](skip.message)
    return { skipped: true }
  }
  const pr = event.pull_request
  const n = pr.number
  const eventHead = pr.head.sha
  const repository = event.repository.full_name
  // The commit the engine scanned. Inline comments need its line numbers to be the pull request
  // head's, so they are posted only when it is the head itself (not a merge commit).
  const scanned = SHA.test(result.head ?? '') ? result.head : eventHead
  const inlineAllowed = scanned === eventHead
  if (!inlineAllowed) {
    log.notice('The scanned commit is not the pull request head (a merge commit?): issues are listed in the summary, not inline. Check out github.event.pull_request.head.sha for inline comments.')
  }

  const own = await client.whoami()
  const logins = new Set([DEFAULT_LOGIN, ...(own ? [own] : [])])
  const ours = (c) => logins.has(c?.user?.login)
  const write = createWriter(client, log)

  // 1. Where an inline comment can go: the RIGHT side lines of each file's patch.
  const files = await client.paginate(`/pulls/${n}/files`)
  const commentable = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]))

  // 2. Equall's live inline comments of this scope, by fingerprint.
  let existingInline = inlineByFingerprint(await client.paginate(`/pulls/${n}/comments`), ours, scope)

  // 3. The summary of this scope, if any.
  const issueComments = await client.paginate(`/issues/${n}/comments`)
  const summary = issueComments.find((c) => ours(c) && String(c.body ?? '').startsWith(summaryMarker(scope)))
  const newIssues = result.new_issues ?? []
  if (!summary && newIssues.length === 0 && existingInline.size === 0) {
    log.debug('Nothing new found and no previous comment: no comment.')
    return { skipped: false, posted: 0, marked: 0, summary: 'none' }
  }

  // 4. A check that is no longer about the pull request's head writes nothing: a newer run
  //    will comment on the newer commit.
  const { data: live } = await client.call('GET', `/pulls/${n}`)
  if (live?.state !== 'open' || live?.head?.sha !== eventHead) {
    log.notice('The pull request changed since this check started: no comment. The run on its latest commit comments.')
    return { skipped: true }
  }

  // 5. New issues: already commented, to comment now, or to list in the summary.
  const current = new Set(newIssues.map((i) => i.fingerprint).filter(Boolean))
  const toPost = []
  const listed = []
  for (const issue of newIssues) {
    const fp = issue.fingerprint
    const prev = fp ? existingInline.get(fp) : undefined
    if (prev) {
      // Back after being marked as no longer found: restore the comment.
      if (prev.resolved) await write('restore an inline comment', 'PATCH', `/pulls/comments/${prev.comment.id}`, { body: renderInline(issue, scope) })
      continue
    }
    const onDiff = inlineAllowed && FINGERPRINT.test(fp ?? '') && Number.isInteger(issue.line) && commentable.get(issue.file_path)?.has(issue.line)
    if (onDiff && toPost.length < MAX_INLINE) toPost.push(issue)
    else listed.push(issue)
  }

  // 6. The inline comments, as one review (one notification). If the review fails, it may
  //    still have been created (a timeout, a 5xx): list the comments again, then post the
  //    missing ones one by one. Whatever still fails goes to the summary list.
  let posted = 0
  if (toPost.length > 0) {
    const comment = (i) => ({ path: i.file_path, line: i.line, side: 'RIGHT', body: renderInline(i, scope) })
    const review = await write('post the review', 'POST', `/pulls/${n}/reviews`, { commit_id: eventHead, event: 'COMMENT', comments: toPost.map(comment) }, { quiet: true })
    if (review.ok) {
      posted = toPost.length
    } else {
      existingInline = inlineByFingerprint(await client.paginate(`/pulls/${n}/comments`), ours, scope)
      for (const issue of toPost) {
        if (existingInline.has(issue.fingerprint)) {
          posted++
          continue
        }
        const single = await write(`comment on ${issue.file_path}:${issue.line}`, 'POST', `/pulls/${n}/comments`, { commit_id: eventHead, ...comment(issue) })
        if (single.ok) posted++
        else listed.push(issue)
      }
    }
  }

  // 7. Inline comments whose issue is gone: marked, not deleted. A file the scanner could not
  //    analyse this time says nothing about its issues, so its comments are left as they are.
  const unchecked = new Set((result.unchecked ?? []).map((u) => u.file_path))
  let marked = 0
  for (const [fp, prev] of existingInline) {
    if (current.has(fp) || prev.resolved || unchecked.has(prev.comment.path)) continue
    const res = await write('mark an inline comment as no longer found', 'PATCH', `/pulls/comments/${prev.comment.id}`, { body: renderInlineResolved(prev.comment.body, scope, fp, scanned) })
    if (res.ok) marked++
  }

  // 8. The summary: created only when something new was found, then kept current.
  if (!summary && newIssues.length === 0) return { skipped: false, posted, marked, summary: 'none' }
  const previous = summary ? parseData(summary.body) : null
  const { fixed, atLeast } = countFixed({ previous, previousBody: summary?.body, sha: scanned, current, unchecked })
  const payload = buildPayload({ result, repository, pullNumber: n, headSha: scanned, engineVersion, fixed })
  const body = renderSummary({ result, payload, listed, pullRequestUrl, scope, scanPath, fixedAtLeast: atLeast })
  if (!summary) {
    const res = await write('post the summary comment', 'POST', `/issues/${n}/comments`, { body })
    return { skipped: false, posted, marked, summary: res.ok ? 'created' : 'failed' }
  }
  if (summary.body !== body) {
    const res = await write('update the summary comment', 'PATCH', `/issues/comments/${summary.id}`, { body })
    return { skipped: false, posted, marked, summary: res.ok ? 'updated' : 'failed' }
  }
  return { skipped: false, posted, marked, summary: 'unchanged' }
}

// ---------------------------------------------------------------------------------------------
// Entry point

function escape(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}
const log = {
  notice: (m) => console.log(`::notice title=Equall::${escape(m)}`),
  warning: (m) => console.log(`::warning title=Equall::${escape(m)}`),
  debug: (m) => console.log(`::debug::${escape(m)}`),
}

export function describeFailure(err) {
  if (err?.permission) {
    return { kind: 'warning', message: 'The workflow token cannot comment on this pull request: add `permissions: pull-requests: write` to the workflow. The check itself is unaffected.' }
  }
  const where = err?.context ? ` (${err.context}${err.status ? `, HTTP ${err.status}` : ''})` : ''
  return { kind: 'warning', message: `Could not comment on the pull request${where}: ${err?.message ?? String(err)}. The check itself is unaffected.` }
}

function readPullRequestUrl(path) {
  if (!path) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    return isAllowedPullRequestUrl(raw) ? raw.replace(/\(/g, '%28').replace(/\)/g, '%29') : null
  } catch {
    return null
  }
}

async function main(argv, env) {
  const [resultPath] = argv
  const token = env.EQUALL_GITHUB_TOKEN
  if (!token) {
    log.warning('No workflow token: no comment.')
    return
  }
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com'
  if (!isAllowedUrl(apiUrl)) {
    log.warning('The GitHub API URL is not https: no comment.')
    return
  }
  let result
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    log.notice('No check result to comment on.')
    return
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const client = createClient({ apiUrl, token, repository: event.repository?.full_name ?? env.GITHUB_REPOSITORY })
  const scanPath = env.EQUALL_SCAN_PATH || '.'
  const scope = computeScope({ workflow: env.GITHUB_WORKFLOW, job: env.GITHUB_JOB, path: scanPath, level: env.EQUALL_LEVEL })
  try {
    const out = await run({
      result,
      event,
      eventName: env.GITHUB_EVENT_NAME,
      actor: env.GITHUB_ACTOR,
      client,
      engineVersion: env.EQUALL_ENGINE_VERSION,
      pullRequestUrl: readPullRequestUrl(env.EQUALL_PR_URL_FILE),
      log,
      scope,
      scanPath,
    })
    if (!out.skipped) log.debug(`scope=${scope} inline posted=${out.posted} marked=${out.marked} summary=${out.summary}`)
  } catch (err) {
    const { kind, message } = describeFailure(err)
    log[kind](message)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((err) => {
    log.warning(`Commenting failed: ${err instanceof Error ? err.message : String(err)}. The check itself is unaffected.`)
  })
}
