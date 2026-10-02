// Stand-in for the Equall ingest endpoint in the self-test: records each request, answers 201.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const [port, out] = process.argv.slice(2)
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    appendFileSync(out, JSON.stringify({ method: req.method, bearer: /^Bearer \S+\.\S+\.\S+$/.test(auth), body: JSON.parse(body) }) + '\n')
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'created', findings: 0 }))
  })
}).listen(Number(port), '127.0.0.1')
