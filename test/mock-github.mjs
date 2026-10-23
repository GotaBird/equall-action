// Stand-in for the GitHub REST API in the comment tests: just the routes comment.mjs uses,
// with pagination through Link headers and an optional forced status.
import { createServer } from 'node:http'

export function startMockGitHub({ repository = 'acme/site', pull = 42, files = [], pageSize = 100, forceStatus = null } = {}) {
  const state = { files, reviewComments: [], issueComments: [], requests: [], nextId: 1000, forceStatus }
  const prefix = `/repos/${repository}`
  const bot = { login: 'github-actions[bot]', type: 'Bot' }

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
      if (req.method === 'GET' && p === `${prefix}/pulls/${pull}/files`) return list(state.files)
      if (req.method === 'GET' && p === `${prefix}/pulls/${pull}/comments`) return list(state.reviewComments)
      if (req.method === 'GET' && p === `${prefix}/issues/${pull}/comments`) return list(state.issueComments)
      if (req.method === 'POST' && p === `${prefix}/pulls/${pull}/reviews`) {
        for (const c of body.comments) state.reviewComments.push({ id: state.nextId++, user: bot, commit_id: body.commit_id, ...c })
        return send(200, { id: state.nextId++ })
      }
      if (req.method === 'POST' && p === `${prefix}/pulls/${pull}/comments`) {
        const c = { id: state.nextId++, user: bot, ...body }
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
