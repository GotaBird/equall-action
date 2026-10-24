// Comments on a pull request with what the change introduced, and only that.
//
// Two layers, both kept quiet on purpose:
//   - review comments on the pull request diff: one per changed line that has new issues, and
//     one file-level comment per changed file for the new issues the scanner gives no line for
//     (at most MAX_INLINE new comments per run, never twice for the same issue);
//   - one summary comment, found again and updated through a hidden marker. It is created
//     only when the change introduces at least one new issue; once it exists, later runs keep
//     it current, down to the state where nothing new is found.
//
// Review comments follow their issues by fingerprint, never by line:
//   - all of a comment's issues gone: its text says so, then its thread is resolved (needs
//     `contents: write`), or else the comment is hidden as resolved, or else deleted;
//   - the comment went outdated but its issues are still found: they are commented again where
//     they are now, and the old comment is hidden as outdated (or deleted);
//   - a thread someone resolved by hand stays resolved: its issues are not commented again.
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
const MAX_SNIPPET = 120
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

// One review comment per changed line (or per file, for issues without a line). Its marker
// lists every fingerprint the comment covers (sorted), the ones no longer found (`gone`), and
// its state: `resolved` (all of them gone) or `moved` (outdated, commented again elsewhere).
export function inlineMarker(scope, fps, { gone = [], resolved = false, moved = false } = {}) {
  const closed = resolved || moved
  const g = gone.length > 0 && !closed ? ` gone=${[...gone].sort().join(',')}` : ''
  const state = moved ? ' state=moved' : resolved ? ' state=resolved' : ''
  return `<!-- equall:inline scope=${scope} fp=${[...fps].sort().join(',')}${g}${state} -->`
}

const FP_LIST = '[A-Za-z0-9_-]{1,64}(?:,[A-Za-z0-9_-]{1,64})*'
const MARKER = new RegExp(`^<!-- equall:inline scope=([0-9a-f]{8}) fp=(${FP_LIST})(?: gone=(${FP_LIST}))?(?: state=(resolved|moved))? -->`)

// Parses an Equall inline comment marker: { scope, fps, gone, resolved, moved } or null.
export function parseInlineMarker(body) {
  const m = MARKER.exec(String(body ?? ''))
  return m
    ? { scope: m[1], fps: m[2].split(','), gone: m[3] ? m[3].split(',') : [], resolved: m[4] === 'resolved', moved: m[4] === 'moved' }
    : null
}

const criterionLabel = (c) => (WCAG_NAMES[c] ? `WCAG ${c} ${WCAG_NAMES[c]}` : `WCAG ${c}`)

function footer(issues, { file = false } = {}) {
  const rules = [...new Set(issues.map((i) => i.scanner_rule_id))].map((r) => codeSpan(r)).join(', ')
  const criteria = [...new Set(issues.flatMap(criteriaOf))].map(criterionLabel)
  const where = file ? ' · no line number from the scanner' : ''
  return `<sub>Equall · new in this pull request${where} · ${rules}${criteria.length ? ` · ${criteria.join(', ')}` : ''}</sub>`
}

// The element an issue is about, for file-level comments: the scanner gives no line, so the
// snippet is what lets the reader find it. One line, cut at MAX_SNIPPET characters.
export function snippetOf(issue) {
  const s = String(issue?.html_snippet ?? '').replace(/\s+/g, ' ').trim()
  if (s === '') return null
  return s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET - 1)}…` : s
}

// In a list item: the rule's guidance link, or the lead line of the CLI's hint.
function shortFix(issue) {
  const link = safeLink(issue.help_url)
  if (link) return `**How to fix:** see the [rule's guidance](${link}).`
  const hint = typeof issue.suggestion === 'string' ? issue.suggestion.trim() : ''
  const lead = hint.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  return lead && hint !== 'Auto-fixable' ? `**How to fix:** ${codeSpan(lead)}` : null
}

// The comment for the new issues on one line, or (`file`) in one file when the scanner gives
// them no line. `fps`: every fingerprint the comment covers; `gone`: those no longer found by
// the check on `sha`. One issue and nothing gone: the short form. Otherwise a list, one item
// per issue still found.
export function renderInline(issues, scope, { fps = issues.map((i) => i.fingerprint), gone = [], sha = '', file = false } = {}) {
  const marker = inlineMarker(scope, fps, { gone })
  const element = (i) => {
    const snippet = file ? snippetOf(i) : null
    return snippet ? `**Element:** ${codeSpan(snippet)}` : null
  }
  if (issues.length === 1 && gone.length === 0) {
    const [issue] = issues
    return [marker, `**New issue:** ${codeSpan(plainMessage(issue))}`, '', element(issue), '', whyItMatters(issue.wcag_criteria), '', howToFix(issue), '', footer(issues, { file })]
      .filter((l) => l !== null)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  }
  const items = issues.map((i) => {
    const detail = [whyItMatters(i.wcag_criteria), shortFix(i)].filter(Boolean).join(' ')
    const el = element(i)
    return `- ${codeSpan(plainMessage(i))}${el ? `\n  ${el}` : ''}${detail ? `\n  ${detail}` : ''}`
  })
  const where = file ? 'in this file' : 'on this line'
  const lines = [marker, `**${plural(issues.length, 'new issue', 'new issues')} ${where}:**`, '', ...items]
  if (gone.length > 0) {
    lines.push('', `${gone.length} of these ${gone.length === 1 ? 'is' : 'are'} no longer found on ${codeSpan(String(sha).slice(0, 7))}.`)
  }
  lines.push('', footer(issues, { file }))
  return lines.join('\n')
}

const previousText = (body) => String(body).replace(/^<!-- equall:inline[^>]*-->\n?/, '')
const folded = (body) => ['<details><summary>Previous comment</summary>', '', previousText(body), '', '</details>']

// A comment none of whose issues the latest check finds: its text says so (the original stays,
// folded) before its thread is resolved, hidden or deleted.
export function renderInlineResolved(previousBody, scope, fps, sha) {
  return [inlineMarker(scope, fps, { resolved: true }), `No longer found by the check on ${codeSpan(String(sha).slice(0, 7))}.`, '', ...folded(previousBody)].join('\n')
}

// An outdated comment whose issues are still found: they are commented again where they are
// now (or listed in the summary), and this one is hidden as outdated.
export function renderInlineMoved(previousBody, scope, fps, sha) {
  return [
    inlineMarker(scope, fps, { moved: true }),
    `The code this comment pointed to changed. The issues still found by the check on ${codeSpan(String(sha).slice(0, 7))} are commented again where they are now, or listed in the summary.`,
    '',
    ...folded(previousBody),
  ].join('\n')
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
// `inlineLines` and `inlineFiles`: how many changed lines and files carry the review comments
// of the issues not listed. `resolvedInConversation`: new issues whose thread someone resolved
// by hand, so they are neither commented again nor listed.
export function renderSummary({
  result, payload, listed, pullRequestUrl, scope, scanPath = '.', fixedAtLeast = false, inlineLines = 0, inlineFiles = 0, resolvedInConversation = 0,
}) {
  const n = payload.counts.new
  const fixed = payload.counts.fixed
  const fixedText = fixed > 0 ? ` ${fixedAtLeast ? 'At least ' : ''}${plural(fixed, 'issue', 'issues')} fixed since the last check.` : ''
  const path = normalizePath(scanPath)
  const lines = [summaryMarker(scope), `### Equall${path !== '.' ? ` · ${codeSpan(path)}` : ''}`, '']
  if (n > 0) {
    lines.push(`Equall found ${plural(n, 'new accessibility issue', 'new accessibility issues')} in this pull request.${fixedText}`)
    const inline = n - listed.length - resolvedInConversation
    if (inline > 0) {
      const where = [
        inlineLines > 0 || inlineFiles === 0 ? plural(Math.max(inlineLines, 1), 'changed line', 'changed lines') : null,
        inlineFiles > 0 ? plural(inlineFiles, 'file', 'files') : null,
      ].filter(Boolean)
      lines.push('', `${plural(inline, 'issue', 'issues')} commented on ${where.join(' and ')}.`)
    }
    if (resolvedInConversation > 0) {
      const k = resolvedInConversation
      lines.push('', `${plural(k, 'issue', 'issues')} still found ${k === 1 ? 'was' : 'were'} resolved in the conversation, so ${k === 1 ? 'it is' : 'they are'} not commented again.`)
    }
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

// `graphqlUrl`: defaults to `<apiUrl>/graphql`; null turns GraphQL off. It must be on the same
// origin as the REST API, or GraphQL stays off: the token never goes anywhere else.
export function createClient({ apiUrl, token, repository, graphqlUrl, fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, '')
  const origin = new URL(base).origin
  const gqlUrl = graphqlUrl === undefined ? `${base}/graphql` : graphqlUrl
  let gqlOn = false
  try {
    gqlOn = Boolean(gqlUrl) && new URL(gqlUrl).origin === origin
  } catch {
    gqlOn = false
  }
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
  // GraphQL answers 200 with an `errors` array when it refuses: that is an error too, carrying
  // the error types (FORBIDDEN, NOT_FOUND...) for isPermissionError.
  async function graphql(query, variables, context = 'GraphQL') {
    if (!gqlOn) throw new ApiError(0, 'GraphQL is not available on the API origin', context)
    const { data } = await request('POST', gqlUrl, { query, variables }, context)
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const err = new ApiError(200, data.errors.map((e) => String(e?.message ?? 'error')).join('; '), context)
      err.types = data.errors.map((e) => e?.type).filter(Boolean)
      throw err
    }
    return data?.data ?? null
  }
  return { call, paginate, whoami, graphql, hasGraphql: gqlOn }
}

// A refusal for lack of permission, from REST or GraphQL ("Resource not accessible by
// integration" is what the workflow token gets without `contents: write`).
export function isPermissionError(err) {
  if (!err) return false
  if (err.status === 401 || err.status === 403) return true
  if ((err.types ?? []).some((t) => t === 'FORBIDDEN' || t === 'INSUFFICIENT_SCOPES')) return true
  return /not accessible by integration|insufficient scopes|must have (?:push|write|admin) access/i.test(String(err.message ?? ''))
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated resolvedBy { login } comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`
const RESOLVE_MUTATION = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }'
const MINIMIZE_MUTATION = 'mutation($id: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $id, classifier: $classifier }) { minimizedComment { isMinimized } } }'

// The pull request's review threads, by the database id of their first comment. null when
// GraphQL is not available: the lifecycle then works from the REST data alone.
export async function fetchThreads(client, repository, number) {
  if (!client.graphql || !client.hasGraphql) return null
  const [owner, name] = String(repository).split('/')
  const threads = new Map()
  let after = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await client.graphql(THREADS_QUERY, { owner, name, number, after }, 'GraphQL reviewThreads')
    const conn = data?.repository?.pullRequest?.reviewThreads
    if (!conn) break
    for (const t of conn.nodes ?? []) {
      const first = t?.comments?.nodes?.[0]?.databaseId
      if (Number.isInteger(first)) threads.set(first, { id: t.id, isResolved: Boolean(t.isResolved), isOutdated: Boolean(t.isOutdated), resolvedBy: t.resolvedBy?.login ?? null })
    }
    if (!conn.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return threads
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

// Equall's review comments of this scope (line-level and file-level), with what their thread
// says. Comments marked `moved` were replaced by a newer one: they no longer count.
//   outdated       GitHub no longer shows it on the current diff (REST `line` null, or the
//                  thread is outdated)
//   humanResolved  its thread was resolved by someone else while its issues were open
function collectInline(comments, ours, isOurLogin, scope, threads) {
  const answered = new Set(comments.map((c) => c.in_reply_to_id).filter(Boolean))
  const entries = []
  for (const c of comments) {
    if (!ours(c) || c.in_reply_to_id) continue
    const marker = parseInlineMarker(c.body)
    if (!marker || marker.scope !== scope || marker.moved) continue
    const file = c.subject_type === 'file'
    const thread = threads?.get(c.id) ?? null
    const outdated = (!file && (c.line === null || c.line === undefined)) || thread?.isOutdated === true
    const humanResolved = thread?.isResolved === true && !marker.resolved && !isOurLogin(thread.resolvedBy)
    entries.push({ ...marker, comment: c, file, outdated, thread, humanResolved, answered: answered.has(c.id), added: [] })
  }
  return entries
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
const lineKey = (path, line) => `${path}\0${line}`
const fileKey = (path) => `${path}\0file`
const entryKey = (e) => (e.file ? fileKey(e.comment.path) : lineKey(e.comment.path, e.comment.line))

// Closes a review comment whose text already says why: resolves its thread, or else hides it,
// or else deletes it. What the token cannot do is remembered for the rest of the run, so a
// permission error is met once, not once per comment. A comment someone answered is never
// deleted: the conversation would go with it.
function createCloser({ client, write, log }) {
  const can = { resolve: true, minimize: true }
  let hiddenWithoutResolve = 0
  async function close(e, classifier) {
    if (classifier === 'RESOLVED' && can.resolve && e.thread?.id) {
      try {
        await client.graphql(RESOLVE_MUTATION, { id: e.thread.id }, 'GraphQL resolveReviewThread')
        return 'resolved'
      } catch (err) {
        if (isPermissionError(err)) can.resolve = false
        else log.debug(`Could not resolve a review thread (${err.message}).`)
      }
    }
    const fallback = classifier === 'RESOLVED' && !can.resolve
    if (can.minimize && e.comment.node_id && client.hasGraphql) {
      try {
        await client.graphql(MINIMIZE_MUTATION, { id: e.comment.node_id, classifier }, 'GraphQL minimizeComment')
        if (fallback) hiddenWithoutResolve++
        return 'minimized'
      } catch (err) {
        if (isPermissionError(err)) can.minimize = false
        else log.debug(`Could not hide a review comment (${err.message}).`)
      }
    }
    if (e.answered) return 'kept'
    const del = await write('delete a review comment', 'DELETE', `/pulls/comments/${e.comment.id}`, undefined)
    if (del.ok) {
      if (fallback) hiddenWithoutResolve++
      return 'deleted'
    }
    return 'kept'
  }
  function explain() {
    if (hiddenWithoutResolve === 0) return
    log.notice(
      'The comments of fixed issues were hidden or deleted, because the workflow token cannot resolve review threads. ' +
        'Granting `contents: write` lets Equall resolve them instead; it is not needed, and the README explains why it is not the default.',
    )
  }
  return { close, explain }
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
  // GraphQL names the Actions bot without its `[bot]` suffix.
  const bare = new Set([...logins].map((l) => l.replace(/\[bot\]$/, '')))
  const isOurLogin = (login) => typeof login === 'string' && bare.has(login.replace(/\[bot\]$/, ''))
  const write = createWriter(client, log)

  // 1. Where a review comment can go: the RIGHT side lines of each file's patch, and the
  //    changed files themselves (file-level comments).
  const files = await client.paginate(`/pulls/${n}/files`)
  const commentable = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]))

  // 2. Equall's review comments of this scope, with their threads when GraphQL answers.
  const reviewComments = await client.paginate(`/pulls/${n}/comments`)
  let threads = null
  if (reviewComments.some((c) => ours(c) && parseInlineMarker(c.body)?.scope === scope)) {
    try {
      threads = await fetchThreads(client, repository, n)
    } catch (err) {
      log.debug(`Could not read the review threads (${err.message}): outdated comments are told by their line only.`)
    }
  }
  const existing = collectInline(reviewComments, ours, isOurLogin, scope, threads)

  // 3. The summary of this scope, if any.
  const issueComments = await client.paginate(`/issues/${n}/comments`)
  const summary = issueComments.find((c) => ours(c) && String(c.body ?? '').startsWith(summaryMarker(scope)))
  const newIssues = result.new_issues ?? []
  if (!summary && newIssues.length === 0 && existing.length === 0) {
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

  // 5. Which comments still show their issues. Closed ones (resolved, outdated) do not: their
  //    issues still found are placed again. A thread resolved by hand keeps its issues quiet.
  const current = new Map(newIssues.filter((i) => i.fingerprint).map((i) => [i.fingerprint, i]))
  const byFp = new Map()
  const byKey = new Map()
  for (const e of existing) {
    if (e.humanResolved || e.resolved || e.outdated) continue
    for (const fp of e.fps) if (!byFp.has(fp)) byFp.set(fp, e)
    const key = entryKey(e)
    if (!byKey.has(key)) byKey.set(key, e)
  }
  const quiet = new Set()
  for (const e of existing) if (e.humanResolved) for (const fp of e.fps) if (current.has(fp) && !byFp.has(fp)) quiet.add(fp)

  // 6. New issues: already in a comment, resolved in the conversation, joining the comment
  //    already on their line (or file), in a new comment, or listed in the summary. An issue
  //    without a line gets a file-level comment when its file is part of the pull request.
  const groups = new Map()
  const listed = []
  for (const issue of newIssues) {
    const fp = issue.fingerprint
    if (fp && (byFp.has(fp) || quiet.has(fp))) continue
    let key = null
    if (inlineAllowed && FINGERPRINT.test(fp ?? '')) {
      const hasLine = Number.isInteger(issue.line) && issue.line > 0
      if (hasLine && commentable.get(issue.file_path)?.has(issue.line)) key = lineKey(issue.file_path, issue.line)
      else if (!hasLine && commentable.has(issue.file_path)) key = fileKey(issue.file_path)
    }
    if (!key) {
      listed.push(issue)
      continue
    }
    const there = byKey.get(key)
    if (there) {
      there.added.push(fp)
      byFp.set(fp, there)
    } else {
      if (!groups.has(key)) groups.set(key, { file: key.endsWith('\0file'), issues: [] })
      groups.get(key).issues.push(issue)
    }
  }
  // At most MAX_INLINE new comments, lines and files together; the rest goes to the summary.
  const all = [...groups.values()]
  const toPost = all.slice(0, MAX_INLINE)
  for (const group of all.slice(MAX_INLINE)) listed.push(...group.issues)
  const shownLines = new Set()
  const shownFiles = new Set()
  const show = (path, line, file) => (file ? shownFiles.add(path) : shownLines.add(lineKey(path, line)))

  // 7. The new comments. Line comments go as one review (one notification). If the review
  //    fails, it may still have been created (a timeout, a 5xx): list the comments again, then
  //    post the missing ones one by one. File-level comments cannot be part of a review: they
  //    are posted one by one. Whatever still fails goes to the summary list.
  let posted = 0
  const lineGroups = toPost.filter((g) => !g.file).map((g) => g.issues)
  const fileGroups = toPost.filter((g) => g.file).map((g) => g.issues)
  const done = (g, file) => {
    posted++
    show(g[0].file_path, g[0].line, file)
  }
  if (lineGroups.length > 0) {
    const comment = (g) => ({ path: g[0].file_path, line: g[0].line, side: 'RIGHT', body: renderInline(g, scope) })
    const review = await write('post the review', 'POST', `/pulls/${n}/reviews`, { commit_id: eventHead, event: 'COMMENT', comments: lineGroups.map(comment) }, { quiet: true })
    if (review.ok) {
      lineGroups.forEach((g) => done(g, false))
    } else {
      const again = collectInline(await client.paginate(`/pulls/${n}/comments`), ours, isOurLogin, scope, null)
      const present = new Set(again.filter((e) => !e.resolved && !e.outdated).flatMap((e) => e.fps))
      for (const group of lineGroups) {
        if (group.every((i) => present.has(i.fingerprint))) {
          done(group, false)
          continue
        }
        const single = await write(`comment on ${group[0].file_path}:${group[0].line}`, 'POST', `/pulls/${n}/comments`, { commit_id: eventHead, ...comment(group) })
        if (single.ok) done(group, false)
        else listed.push(...group)
      }
    }
  }
  for (const group of fileGroups) {
    const body = renderInline(group, scope, { file: true })
    const res = await write(`comment on ${group[0].file_path}`, 'POST', `/pulls/${n}/comments`, { commit_id: eventHead, path: group[0].file_path, subject_type: 'file', body })
    if (res.ok) done(group, true)
    else listed.push(...group)
  }

  // 8. Existing comments follow their issues: edited to the remaining ones when some are gone;
  //    closed when all are gone; replaced when outdated with issues still found (those were
  //    placed again in 6). A file the scanner could not analyse this time says nothing about
  //    its issues: left as it is. A thread resolved by hand, or already closed, is not touched.
  const unchecked = new Set((result.unchecked ?? []).map((u) => u.file_path))
  const closer = createCloser({ client, write, log })
  let marked = 0
  for (const e of existing) {
    if (e.humanResolved || e.resolved) continue
    const fps = [...new Set([...e.fps, ...e.added])].sort()
    const present = fps.filter((fp) => current.has(fp))
    const gone = fps.filter((fp) => !current.has(fp))
    const path = e.comment.path
    if (present.length === 0) {
      if (unchecked.has(path)) continue
      const res = await write('mark an inline comment as no longer found', 'PATCH', `/pulls/comments/${e.comment.id}`, { body: renderInlineResolved(e.comment.body, scope, fps, scanned) })
      if (!res.ok) continue
      marked++
      await closer.close(e, 'RESOLVED')
      continue
    }
    if (e.outdated) {
      const res = await write('mark an outdated inline comment', 'PATCH', `/pulls/comments/${e.comment.id}`, { body: renderInlineMoved(e.comment.body, scope, fps, scanned) })
      if (res.ok) await closer.close(e, 'OUTDATED')
      continue
    }
    const unchanged = e.added.length === 0 && sameSet(e.gone, gone)
    if (unchanged || (unchecked.has(path) && e.added.length === 0)) {
      show(path, e.comment.line, e.file)
      continue
    }
    const body = renderInline(present.map((fp) => current.get(fp)), scope, { fps, gone, sha: scanned, file: e.file })
    const res = await write('update an inline comment', 'PATCH', `/pulls/comments/${e.comment.id}`, { body })
    // When the edit fails, the issues already in its text stay visible there; the added ones
    // go to the summary.
    if (!res.ok) for (const fp of e.added) listed.push(current.get(fp))
    show(path, e.comment.line, e.file)
  }
  closer.explain()

  // 9. The summary: created only when something new was found, then kept current.
  if (!summary && newIssues.length === 0) return { skipped: false, posted, marked, summary: 'none' }
  const previous = summary ? parseData(summary.body) : null
  const { fixed, atLeast } = countFixed({ previous, previousBody: summary?.body, sha: scanned, current, unchecked })
  const payload = buildPayload({ result, repository, pullNumber: n, headSha: scanned, engineVersion, fixed })
  const body = renderSummary({
    result, payload, listed, pullRequestUrl, scope, scanPath, fixedAtLeast: atLeast,
    inlineLines: shownLines.size, inlineFiles: shownFiles.size, resolvedInConversation: quiet.size,
  })
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
  // GraphQL resolves and hides review threads. Off when its URL is not https (or http on
  // localhost) on the API's own origin: the lifecycle then falls back to deleting comments.
  const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${apiUrl.replace(/\/+$/, '')}/graphql`
  const client = createClient({ apiUrl, token, repository: event.repository?.full_name ?? env.GITHUB_REPOSITORY, graphqlUrl: isAllowedUrl(graphqlUrl) ? graphqlUrl : null })
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
