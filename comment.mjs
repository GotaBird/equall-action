// Comments on a pull request with what the change introduced, and only that.
//
// Two layers, both kept quiet on purpose:
//   - one inline review comment per new issue, on its line, when that line is part of the
//     pull request diff (at most MAX_INLINE per run, never twice for the same issue);
//   - one summary comment, found again and updated through a hidden marker. It is created
//     only when the change introduces at least one new issue; once it exists, later runs keep
//     it current, down to the state where nothing new is found.
//
// Called by action.yml when `comment` is on. Like report.mjs, it is accessory: it always exits
// 0 and speaks through workflow commands, so the check's own result never depends on it.
//
// Usage: node comment.mjs <result.json>

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isAllowedUrl, isAllowedPullRequestUrl } from './report.mjs'

export const SUMMARY_MARKER = '<!-- equall:pr-comment -->'
export const SCHEMA = 'equall.pr-check/v1'
export const MAX_INLINE = 10
export const MAX_PAYLOAD_ISSUES = 50
const MAX_LISTED = 100
const MAX_FILES_LISTED = 5
const MAX_PAGES = 30
const COMMENT_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review']
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor']

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
  '1.1.1': 'People using a screen reader get no description of this content, or only its file name.',
  '1.3.1': 'Screen reader users lose the structure sighted users see, such as which label goes with which field.',
  '1.4.3': 'People with low vision may not be able to read text that does not stand out from its background.',
  '2.1.1': 'People who use a keyboard or a switch device cannot reach or operate this control.',
  '2.4.1': 'Keyboard and screen reader users have to go through repeated content before reaching the main content.',
  '2.4.2': 'Screen reader users and anyone switching tabs cannot tell what this page is about.',
  '2.4.4': 'Screen reader users who browse a list of links cannot tell where this link goes.',
  '2.4.6': 'People navigating by headings or labels cannot tell sections or fields apart.',
  '2.5.3': 'Voice control users cannot activate this control by saying the label they see.',
  '3.1.1': 'Screen readers may pronounce this page with the wrong language rules.',
  '3.3.1': 'People who cannot see the error styling are not told that, or why, a field is invalid.',
  '3.3.2': 'People using a screen reader or voice control cannot tell what this field expects.',
  '4.1.2': 'Assistive technologies cannot announce what this element is or what it does.',
  '4.1.3': 'Screen reader users are not told about this status change.',
}

// ---------------------------------------------------------------------------------------------
// Rendering

// Neutralize text that goes into Markdown: no HTML, no breaking out of a table cell.
export function md(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

// A code span: GitHub renders any HTML in it as text. The pipe is escaped for table cells.
const code = (s) => `\`${String(s ?? '').replace(/[`\r\n]/g, '').replace(/\|/g, '\\|')}\``
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

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
  const list = Array.isArray(criteria) ? criteria : []
  for (const c of list) if (WHO_IT_AFFECTS[c]) return WHO_IT_AFFECTS[c]
  const named = list.map((c) => (WCAG_NAMES[c] ? `${c} ${WCAG_NAMES[c]}` : c))
  return named.length > 0 ? `It fails WCAG ${named.join(', ')}.` : null
}

// "How to fix": the CLI's hint when it has a real one, otherwise the rule's guidance link.
export function howToFix(issue) {
  const hint = typeof issue.suggestion === 'string' ? issue.suggestion.trim() : ''
  if (hint !== '' && hint !== 'Auto-fixable') {
    const [lead, ...rest] = hint.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const bullets = rest.slice(0, 4).map((l) => `- ${md(l)}`)
    if (rest.length > 4) bullets.push('- …')
    return [`**How to fix:** ${md(lead)}`, ...bullets].join('\n')
  }
  const link = safeLink(issue.help_url)
  return link ? `**How to fix:** see the [rule's guidance](${link}).` : null
}

const inlineMarker = (fp, state) => `<!-- equall:inline fp=${fp}${state === 'resolved' ? ' state=resolved' : ''} -->`

export function renderInline(issue) {
  const criteria = (issue.wcag_criteria ?? []).map((c) => (WCAG_NAMES[c] ? `WCAG ${c} ${WCAG_NAMES[c]}` : `WCAG ${c}`))
  return [
    inlineMarker(issue.fingerprint),
    `**${md(plainMessage(issue))}**`,
    '',
    whyItMatters(issue.wcag_criteria),
    '',
    howToFix(issue),
    '',
    `<sub>Equall · new in this pull request · ${code(issue.scanner_rule_id)}${criteria.length ? ` · ${md(criteria.join(', '))}` : ''}</sub>`,
  ]
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

// An inline comment whose issue the latest check no longer finds: kept, marked, never deleted.
export function renderInlineResolved(previousBody, fp, headSha) {
  const original = previousBody.replace(/^<!-- equall:inline[^>]*-->\n?/, '')
  return [
    inlineMarker(fp, 'resolved'),
    `No longer found by the check on ${code(String(headSha).slice(0, 7))}.`,
    '',
    '<details><summary>Previous comment</summary>',
    '',
    original,
    '',
    '</details>',
  ].join('\n')
}

// Parses an Equall inline comment marker: { fp, resolved } or null.
export function parseInlineMarker(body) {
  const m = /^<!-- equall:inline fp=([A-Za-z0-9_-]+)( state=resolved)? -->/.exec(String(body ?? ''))
  return m ? { fp: m[1], resolved: Boolean(m[2]) } : null
}

function fileList(files) {
  const shown = files.slice(0, MAX_FILES_LISTED).map(code).join(', ')
  return files.length > MAX_FILES_LISTED ? `${shown} and ${files.length - MAX_FILES_LISTED} more` : shown
}

// The JSON goes inside an HTML comment: `<` and `>` are escaped so it can never close it.
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
  }
}

// `listed`: the new issues not already shown inline. `pullRequestUrl`: validated, or null.
export function renderSummary({ result, payload, listed, pullRequestUrl }) {
  const n = payload.counts.new
  const fixed = payload.counts.fixed
  const fixedText = fixed > 0 ? ` ${plural(fixed, 'issue', 'issues')} fixed since the last check.` : ''
  const lines = [SUMMARY_MARKER, '### Equall', '']
  if (n > 0) {
    lines.push(`Equall found ${plural(n, 'new accessibility issue', 'new accessibility issues')} in this pull request.${fixedText}`)
  } else {
    lines.push(`No new accessibility issue found by static checks in this pull request.${fixedText}`)
  }
  if (n > 0) lines.push('', n - listed.length > 0 ? `${n - listed.length} of them ${n - listed.length === 1 ? 'is' : 'are'} commented on the changed lines.` : '')

  if (listed.length > 0) {
    const rows = listed.slice(0, MAX_LISTED).map((i) => {
      const where = Number.isInteger(i.line) && i.line > 0 ? `${i.file_path}:${i.line}` : i.file_path
      return `| ${code(where)} | ${md(plainMessage(i))} (${code(i.scanner_rule_id)}) | ${md((i.wcag_criteria ?? []).join(', '))} |`
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
    `<sub>Checked commit ${code(String(payload.head_sha).slice(0, 7))}. Static checks only: contrast, focus order and other rendered checks need their own test. ` +
      'For agents: the data block in this comment lists the new issues of this check; the Equall MCP tool `get_pull_request_check` returns the same data.</sub>',
    '',
    `<!-- equall:data ${encodeData(payload)} -->`,
  )
  return lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n')
}

// ---------------------------------------------------------------------------------------------
// Diff mapping

// Lines of the new file (RIGHT side) a review comment can be attached to: added and context
// lines inside the hunks of a unified patch, as the pull request files API returns it.
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
    if (!inHunk || raw.startsWith('-') || raw.startsWith('\\')) continue
    lines.add(right)
    right++
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// GitHub API

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
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
  async function call(method, pathOrUrl, body) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${base}/repos/${repository}${pathOrUrl}`
    // The token only goes back to the API it came from.
    if (new URL(url).origin !== origin) throw new ApiError(0, 'refusing to follow a link outside the API')
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await res.json().catch(() => null)
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, data?.message ?? `HTTP ${res.status}`)
    return { data, link: res.headers?.get?.('link') ?? null }
  }
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
  return { call, paginate }
}

// Only comments a bot wrote count as Equall's: a marker pasted by a person is ignored.
const byBot = (c) => c?.user?.type === 'Bot'

// ---------------------------------------------------------------------------------------------
// Orchestration

// Why commenting is skipped, or null. `kind` picks the workflow command.
export function skipReason({ eventName, event, actor }) {
  if (eventName !== 'pull_request') return { kind: 'debug', message: `Not a pull_request event (${eventName}): no comment.` }
  if (!COMMENT_ACTIONS.includes(event.action)) return { kind: 'debug', message: `Pull request ${event.action}: no comment.` }
  const pr = event.pull_request
  if (!pr || !Number.isInteger(pr.number)) return { kind: 'debug', message: 'No pull request in the event: no comment.' }
  if (pr.head?.repo?.full_name && pr.head.repo.full_name !== event.repository?.full_name) {
    return { kind: 'notice', message: 'Pull request from a fork: its token cannot comment, so the results are in the job summary only.' }
  }
  if (actor === 'dependabot[bot]') return { kind: 'notice', message: 'Dependabot pull requests get a read-only token: no comment.' }
  return null
}

export async function run({ result, event, eventName, actor, client, engineVersion, pullRequestUrl, log }) {
  const skip = skipReason({ eventName, event, actor })
  if (skip) {
    log[skip.kind](skip.message)
    return { skipped: true }
  }
  const pr = event.pull_request
  const n = pr.number
  const headSha = pr.head.sha
  const repository = event.repository.full_name

  // 1. Where an inline comment can go: the RIGHT side lines of each file's patch.
  const files = await client.paginate(`/pulls/${n}/files`)
  const commentable = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]))

  // 2. Equall's inline comments already on the pull request, by fingerprint.
  const reviewComments = (await client.paginate(`/pulls/${n}/comments`)).filter(byBot)
  const existingInline = new Map()
  for (const c of reviewComments) {
    const marker = parseInlineMarker(c.body)
    if (marker && !existingInline.has(marker.fp)) existingInline.set(marker.fp, { ...marker, comment: c })
  }

  // 3. New issues: already commented, to comment now, or to list in the summary.
  const newIssues = result.new_issues ?? []
  const current = new Set(newIssues.map((i) => i.fingerprint).filter(Boolean))
  const toPost = []
  const listed = []
  for (const issue of newIssues) {
    const fp = issue.fingerprint
    if (fp && existingInline.has(fp)) {
      const prev = existingInline.get(fp)
      // Back after being marked as no longer found: restore the comment.
      if (prev.resolved) await client.call('PATCH', `/pulls/comments/${prev.comment.id}`, { body: renderInline(issue) })
      continue
    }
    const onDiff = fp && Number.isInteger(issue.line) && commentable.get(issue.file_path)?.has(issue.line)
    if (onDiff && toPost.length < MAX_INLINE) toPost.push(issue)
    else listed.push(issue)
  }

  // 4. Post the inline comments as one review (one notification). If GitHub refuses the batch,
  //    fall back to one by one; whatever still fails goes to the summary list.
  let posted = 0
  if (toPost.length > 0) {
    const comments = toPost.map((i) => ({ path: i.file_path, line: i.line, side: 'RIGHT', body: renderInline(i) }))
    try {
      await client.call('POST', `/pulls/${n}/reviews`, { commit_id: headSha, event: 'COMMENT', comments })
      posted = toPost.length
    } catch (err) {
      if (err.status === 403) throw err
      for (const [k, issue] of toPost.entries()) {
        try {
          await client.call('POST', `/pulls/${n}/comments`, { commit_id: headSha, ...comments[k] })
          posted++
        } catch (inner) {
          if (inner.status === 403) throw inner
          listed.push(issue)
        }
      }
    }
  }

  // 5. Inline comments whose issue is gone: marked, not deleted. A file the scanner could not
  //    analyse this time says nothing about its issues, so its comments are left as they are.
  const unchecked = new Set((result.unchecked ?? []).map((u) => u.file_path))
  let marked = 0
  for (const [fp, prev] of existingInline) {
    if (current.has(fp) || prev.resolved || unchecked.has(prev.comment.path)) continue
    await client.call('PATCH', `/pulls/comments/${prev.comment.id}`, { body: renderInlineResolved(prev.comment.body, fp, headSha) })
    marked++
  }

  // 6. The summary: found again by its marker; created only when something new was found.
  const issueComments = (await client.paginate(`/issues/${n}/comments`)).filter(byBot)
  const summary = issueComments.find((c) => String(c.body ?? '').startsWith(SUMMARY_MARKER))
  if (!summary && newIssues.length === 0) {
    log.debug('Nothing new found and no previous summary: no comment.')
    return { skipped: false, posted, marked, summary: 'none' }
  }
  const previous = summary ? parseData(summary.body) : null
  const fixed = countFixed({ previous, headSha, current, unchecked })
  const payload = buildPayload({ result, repository, pullNumber: n, headSha, engineVersion, fixed })
  const body = renderSummary({ result, payload, listed, pullRequestUrl })
  if (!summary) {
    await client.call('POST', `/issues/${n}/comments`, { body })
    return { skipped: false, posted, marked, summary: 'created' }
  }
  if (summary.body !== body) {
    await client.call('PATCH', `/issues/comments/${summary.id}`, { body })
    return { skipped: false, posted, marked, summary: 'updated' }
  }
  return { skipped: false, posted, marked, summary: 'unchanged' }
}

// Issues the previous check listed that this one no longer finds. A re-run on the same commit
// keeps the previous count; a file that could not be analysed this time is not counted as fixed.
export function countFixed({ previous, headSha, current, unchecked }) {
  if (!previous) return 0
  if (previous.head_sha === headSha) return Number.isInteger(previous.counts?.fixed) ? previous.counts.fixed : 0
  const gone = (previous.new_issues ?? []).filter((i) => i.fingerprint && !current.has(i.fingerprint) && !unchecked.has(i.file))
  return gone.length
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
  if (err?.status === 403 || err?.status === 401) {
    return { kind: 'warning', message: 'The workflow token cannot comment on this pull request: add `permissions: pull-requests: write` to the workflow. The check itself is unaffected.' }
  }
  return { kind: 'warning', message: `Could not comment on the pull request: ${err?.message ?? String(err)}. The check itself is unaffected.` }
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
    })
    if (!out.skipped) log.debug(`inline posted=${out.posted} marked=${out.marked} summary=${out.summary}`)
  } catch (err) {
    const { kind, message } = describeFailure(err)
    log[kind](message)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((err) => {
    log.warning(`Commenting failed: ${err instanceof Error ? err.message : String(err)}. The check itself is unaffected.`)
  })
}
