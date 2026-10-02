// Reports a pull request check (or the pull request's closing) to the Equall platform.
//
// Called by action.yml only when `report-to` and `project-key` are both set. The upload is
// accessory: whatever happens here, the job's status stays the gate's own exit code. This
// script always exits 0 and speaks through workflow commands (notice / warning / debug).
//
// Usage: node report.mjs check <result.json> <exit-code>
//        node report.mjs closed

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const AUDIENCE = 'https://equallscan.com'
export const MAX_FINDINGS = 5000
export const MAX_BYTES = 2 * 1024 * 1024
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor']
const SHA = /^[0-9a-f]{40}$/
const RETRY_DELAYS_MS = [2000, 5000]

// Only these fields leave the runner: never the snippet, the suggestion, the help link or
// the source code.
function toFinding(issue, kind) {
  const line = Number.isInteger(issue.line) && issue.line > 0 ? issue.line : null
  return {
    kind,
    fingerprint: typeof issue.fingerprint === 'string' && issue.fingerprint !== '' ? issue.fingerprint : null,
    scanner: issue.scanner,
    scanner_rule_id: typeof issue.scanner_rule_id === 'string' && issue.scanner_rule_id !== '' ? issue.scanner_rule_id : null,
    wcag_criteria: Array.isArray(issue.wcag_criteria) ? issue.wcag_criteria : null,
    severity: SEVERITIES.includes(issue.severity) ? issue.severity : null,
    file_path: issue.file_path,
    line,
    message: issue.message,
  }
}

// A finding the platform can identify: a fingerprint, or a rule id and a line.
function hasIdentity(f) {
  return f.fingerprint !== null || (f.scanner_rule_id !== null && f.line !== null)
}

export function buildCheck({ result, exitCode, event, env, engineVersion, failOn, projectKey, now = new Date() }) {
  const pr = event.pull_request
  const all = [
    ...result.new_issues.map((i) => toFinding(i, 'new')),
    ...result.new_review_only.map((i) => toFinding(i, 'review_only')),
    ...result.new_advisory.map((i) => toFinding(i, 'advisory')),
  ]
  const findings = all.filter(hasIdentity)
  const count = (sev) => result.new_issues.filter((i) => i.severity === sev).length
  return {
    envelope: {
      kind: 'check',
      payload_version: 1,
      repository_id: String(event.repository.id),
      project_key: projectKey,
      pr_number: pr.number,
      title: pr.title ?? null,
      author_login: pr.user?.login ?? null,
      base_ref: pr.base.ref,
      head_sha: pr.head.sha,
      merge_base_sha: SHA.test(result.merge_base ?? '') ? result.merge_base : null,
      gh_run_id: String(env.GITHUB_RUN_ID),
      gh_run_attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
      engine_version: engineVersion,
      fail_on: SEVERITIES.includes(failOn) ? failOn : null,
      passed: exitCode === 0,
      checked_at: now.toISOString(),
      counts: {
        new_critical: count('critical'),
        new_serious: count('serious'),
        new_moderate: count('moderate'),
        new_minor: count('minor'),
        review_only_count: result.summary.new_review_only_count,
        advisory_count: result.summary.new_advisory_count,
        legacy_count: result.summary.legacy_count,
        unchecked_count: result.summary.unchecked_count,
      },
      findings,
    },
    dropped: all.length - findings.length,
  }
}

export function buildClosed({ event, projectKey }) {
  const pr = event.pull_request
  if (!pr || !Number.isInteger(pr.number) || typeof pr.merged !== 'boolean') return null
  return {
    kind: 'closed',
    payload_version: 1,
    repository_id: String(event.repository.id),
    project_key: projectKey,
    pr_number: pr.number,
    merged: pr.merged,
    closed_at: pr.closed_at ?? new Date().toISOString(),
  }
}

// What to do with a response: 2xx is done, 5xx and 429 are retried, anything else is final.
export function classify(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 429 || status >= 500) return 'retry'
  return 'final'
}

// Workflow commands: strip the characters that would end or forge a command.
function escape(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}
const notice = (m) => console.log(`::notice title=Equall::${escape(m)}`)
const warning = (m) => console.log(`::warning title=Equall::${escape(m)}`)
const debug = (m) => console.log(`::debug::${escape(m)}`)

async function idToken(env) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !bearer) return null
  const res = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { Authorization: `bearer ${bearer}` },
  })
  if (!res.ok) throw new Error(`the runner refused an identity token (HTTP ${res.status})`)
  const { value } = await res.json()
  // Mask it in case anything ever echoes it.
  console.log(`::add-mask::${value}`)
  return value
}

// The token's `ref` and `event_name` claims are not secret; logged at debug level so a
// binding refusal can be diagnosed with step debug logging on.
function debugClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    debug(`identity token: event_name=${claims.event_name} ref=${claims.ref}`)
  } catch {
    // not worth a warning
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function send({ url, token, body, fetchImpl = fetch, delays = RETRY_DELAYS_MS }) {
  for (let attempt = 0; ; attempt++) {
    let status
    let payload = null
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      })
      status = res.status
      payload = await res.json().catch(() => null)
    } catch (err) {
      status = 0
      payload = { message: err instanceof Error ? err.message : String(err) }
    }
    const verdict = status === 0 ? 'retry' : classify(status)
    if (verdict !== 'retry' || attempt >= delays.length) return { status, payload }
    await sleep(delays[attempt])
  }
}

function report({ status, payload }) {
  const message = payload?.message ?? ''
  if (status >= 200 && status < 300) {
    notice(`Reported to Equall (${payload?.status ?? status}).`)
  } else if (status === 404) {
    notice('This repository is not connected to Equall, or the project key does not match: results were not uploaded.')
  } else if (status === 403) {
    notice(`Equall did not accept this report: ${message}`)
  } else if (status === 0) {
    warning(`Could not reach Equall: ${message}. The check itself is unaffected.`)
  } else {
    warning(`Equall rejected the report (HTTP ${status}${message ? `: ${message}` : ''}). The check itself is unaffected.`)
  }
}

async function main(argv, env) {
  const [mode, resultPath, exitCodeArg] = argv
  const url = env.EQUALL_REPORT_TO
  const projectKey = env.EQUALL_PROJECT_KEY
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))

  let envelope
  if (mode === 'closed') {
    envelope = buildClosed({ event, projectKey })
    if (!envelope) {
      warning('The pull request event has no number or merged flag: nothing reported.')
      return
    }
  } else {
    let result
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8'))
    } catch {
      warning('No scan result to report.')
      return
    }
    const built = buildCheck({
      result,
      exitCode: Number(exitCodeArg),
      event,
      env,
      engineVersion: env.EQUALL_ENGINE_VERSION,
      failOn: env.FAIL_ON,
      projectKey,
    })
    envelope = built.envelope
    if (built.dropped > 0) warning(`${built.dropped} finding(s) without a stable identity were not reported.`)
    if (envelope.findings.length > MAX_FINDINGS) {
      warning(`More than ${MAX_FINDINGS} new findings: too many to report. The check itself is unaffected.`)
      return
    }
  }

  const body = JSON.stringify(envelope)
  if (Buffer.byteLength(body) > MAX_BYTES) {
    warning('The report is over 2 MiB: not uploaded. The check itself is unaffected.')
    return
  }

  let token
  try {
    token = await idToken(env)
  } catch (err) {
    warning(`${err.message}. Nothing reported.`)
    return
  }
  if (!token) {
    // Pull requests from forks get no identity token: expected, so silent.
    const pr = event.pull_request
    const fromFork = pr?.head?.repo && pr.head.repo.full_name !== event.repository.full_name
    if (!fromFork) notice('No identity token: add `permissions: id-token: write` to the workflow to report to Equall.')
    return
  }
  debugClaims(token)
  report(await send({ url, token, body }))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((err) => {
    warning(`Reporting failed: ${err instanceof Error ? err.message : String(err)}. The check itself is unaffected.`)
  })
}
