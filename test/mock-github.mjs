// Stand-in for the GitHub REST API in the comment tests: just the routes comment.mjs uses,
// with pagination through Link headers and injectable failures:
//   forceStatus       every request answers this status
//   forceWriteStatus  every POST or PATCH answers this status
//   failures          [{ method, match: RegExp, status, times }] for the matching requests
//   reviewThenFail    a review is created, then answered with this status (a timeout, a 5xx)
// and a /graphql endpoint for review threads: every root review comment is a thread. Its state
// lives in state.threads (by comment id): { isResolved, resolvedBy, isOutdated }, set by the
// tests or by the mutations. Options for the mutations:
//   resolve           'ok' | 'forbidden' (the workflow token without contents: write)
//   minimize          'ok' | 'forbidden' | 'error'
//   graphql           false: the endpoint answers 404
import { createServer } from 'node:http'

export function startMockGitHub({
  repository = 'acme/site', pull = 42, files = [], pageSize = 100, head = 'a'.repeat(40),
  forceStatus = null, forceWriteStatus = null, failures = [], reviewThenFail = null, userLogin = null,
  botLogin = 'github-actions[bot]', resolve = 'ok', minimize = 'ok', graphql = true,
} = {}) {
  const state = {
    files, reviewComments: [], issueComments: [], requests: [], nextId: 1000,
    forceStatus, forceWriteStatus, failures, reviewThenFail, userLogin, prHead: head, prState: 'open',
    threads: new Map(), minimized: new Map(), resolve, minimize, graphql, pageSize,
  }
  const prefix = `/repos/${repository}`
  const bot = { login: botLogin, type: 'Bot' }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const body = raw ? JSON.parse(raw) : undefined
      state.requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization })
      const send = (status, data, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(JSON.stringify(data))
      }
      if (state.forceStatus) return send(state.forceStatus, { message: 'Resource not accessible by integration' })
      if (req.method === 'POST' && url.pathname === '/graphql') return graphqlRoute(state, body, send, botLogin)
      const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE'
      if (isWrite && state.forceWriteStatus) return send(state.forceWriteStatus, { message: 'Resource not accessible by integration' })
      const failure = state.failures.find((f) => f.method === req.method && f.match.test(url.pathname) && (f.times ?? 1) > 0)
      if (failure) {
        failure.times = (failure.times ?? 1) - 1
        return send(failure.status, { message: 'Injected failure' })
      }

      const list = (items) => {
        const page = Number(url.searchParams.get('page') || 1)
        const size = Math.min(Number(url.searchParams.get('per_page') || 30), pageSize)
        const slice = items.slice((page - 1) * size, page * size)
        const headers = {}
        if (page * size < items.length) {
          const next = new URL(url)
          next.searchParams.set('page', String(page + 1))
          headers.Link = `<${next.href}>; rel="next"`
        }
        send(200, slice, headers)
      }

      const p = url.pathname
      const m = (re) => re.exec(p)
      let r
      if (req.method === 'GET' && p === '/user') {
        return state.userLogin ? send(200, { login: state.userLogin }) : send(403, { message: 'Resource not accessible by integration' })
      }
      if (req.method === 'GET' && p === `${prefix}/pulls/${pull}`) return send(200, { number: pull, state: state.prState, head: { sha: state.prHead } })
      if (req.method === 'GET' && p === `${prefix}/pulls/${pull}/files`) return list(state.files)
      if (req.method === 'GET' && p === `${prefix}/pulls/${pull}/comments`) return list(state.reviewComments)
      if (req.method === 'GET' && p === `${prefix}/issues/${pull}/comments`) return list(state.issueComments)
      if (req.method === 'POST' && p === `${prefix}/pulls/${pull}/reviews`) {
        for (const c of body.comments) {
          const id = state.nextId++
          state.reviewComments.push({ id, node_id: `PRRC_${id}`, user: bot, commit_id: body.commit_id, subject_type: 'line', ...c })
        }
        if (state.reviewThenFail) return send(state.reviewThenFail, { message: 'Server Error' })
        return send(200, { id: state.nextId++ })
      }
      if (req.method === 'POST' && p === `${prefix}/pulls/${pull}/comments`) {
        const id = state.nextId++
        const c = { id, node_id: `PRRC_${id}`, user: bot, subject_type: 'line', ...body }
        if (c.subject_type === 'file') c.line = null
        state.reviewComments.push(c)
        return send(201, c)
      }
      if (req.method === 'POST' && p === `${prefix}/issues/${pull}/comments`) {
        const c = { id: state.nextId++, user: bot, body: body.body }
        state.issueComments.push(c)
        return send(201, c)
      }
      if (req.method === 'PATCH' && (r = m(/\/pulls\/comments\/(\d+)$/))) {
        const c = state.reviewComments.find((x) => x.id === Number(r[1]))
        if (!c) return send(404, { message: 'Not Found' })
        c.body = body.body
        return send(200, c)
      }
      if (req.method === 'DELETE' && (r = m(/\/pulls\/comments\/(\d+)$/))) {
        const i = state.reviewComments.findIndex((x) => x.id === Number(r[1]))
        if (i < 0) return send(404, { message: 'Not Found' })
        state.reviewComments.splice(i, 1)
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'PATCH' && (r = m(/\/issues\/comments\/(\d+)$/))) {
        const c = state.issueComments.find((x) => x.id === Number(r[1]))
        if (!c) return send(404, { message: 'Not Found' })
        c.body = body.body
        return send(200, c)
      }
      send(404, { message: 'Not Found' })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ state, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

const FORBIDDEN = { type: 'FORBIDDEN', message: 'Resource not accessible by integration' }

function graphqlRoute(state, body, send, botLogin) {
  if (!state.graphql) return send(404, { message: 'Not Found' })
  const q = String(body?.query ?? '')
  const v = body?.variables ?? {}
  const thread = (id) => {
    if (!state.threads.has(id)) state.threads.set(id, { isResolved: false, resolvedBy: null, isOutdated: false })
    return state.threads.get(id)
  }
  if (q.includes('resolveReviewThread')) {
    if (state.resolve === 'forbidden') return send(200, { data: { resolveReviewThread: null }, errors: [FORBIDDEN] })
    const id = Number(String(v.id).replace(/^T_/, ''))
    if (!state.reviewComments.some((c) => c.id === id)) return send(200, { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] })
    Object.assign(thread(id), { isResolved: true, resolvedBy: botLogin.replace(/\[bot\]$/, '') })
    return send(200, { data: { resolveReviewThread: { thread: { id: v.id, isResolved: true } } } })
  }
  if (q.includes('minimizeComment')) {
    if (state.minimize === 'forbidden') return send(200, { data: { minimizeComment: null }, errors: [FORBIDDEN] })
    if (state.minimize === 'error') return send(502, { message: 'Bad Gateway' })
    const c = state.reviewComments.find((x) => x.node_id === v.id)
    if (!c) return send(200, { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] })
    state.minimized.set(c.id, v.classifier)
    return send(200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } })
  }
  if (q.includes('reviewThreads')) {
    const roots = state.reviewComments.filter((c) => !c.in_reply_to_id)
    const start = v.after ? Number(v.after) : 0
    const size = Math.min(100, state.pageSize)
    const nodes = roots.slice(start, start + size).map((c) => {
      const t = thread(c.id)
      const outdated = t.isOutdated || (c.subject_type !== 'file' && (c.line === null || c.line === undefined))
      return { id: `T_${c.id}`, isResolved: t.isResolved, isOutdated: outdated, resolvedBy: t.resolvedBy ? { login: t.resolvedBy } : null, comments: { nodes: [{ databaseId: c.id }] } }
    })
    const hasNextPage = start + size < roots.length
    return send(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + size) : null }, nodes } } } } })
  }
  send(200, { data: null, errors: [{ message: 'unsupported query' }] })
}
