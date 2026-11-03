#!/usr/bin/env node

/**
 * Serve the Next.js static export from a real HTTP origin.
 *
 * This is intentionally dependency-free so it can be used in the build
 * environment and in CI without starting `next start` or a development
 * server.  The `/__health` endpoint is only for this local preview process;
 * it is not part of the packaged application.
 */

import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configuredRoot = process.env.STATIC_ROOT || path.join(projectRoot, 'out')
const root = path.resolve(configuredRoot)
const host = process.env.STATIC_HOST || '127.0.0.1'
const port = Number(process.env.STATIC_PORT || process.env.PORT || 4173)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid STATIC_PORT/PORT: ${port}`)
  process.exitCode = 2
  process.exit()
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  const payload = Buffer.from(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': payload.byteLength,
    'content-type': contentType,
  })
  response.end(payload)
}

function sendJson(response, status, value) {
  sendText(response, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

function isWithinRoot(candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function requestPath(url) {
  // URL() also rejects malformed percent-encoding before a path is resolved.
  return decodeURIComponent(new URL(url, 'http://static.local').pathname)
}

async function resolveFile(requestedPath) {
  const relative = requestedPath === '/' ? 'index.html' : requestedPath.slice(1)
  const candidate = path.resolve(root, relative)
  if (!isWithinRoot(candidate)) return null

  try {
    const stat = await fs.stat(candidate)
    if (stat.isFile()) return candidate
    if (!stat.isDirectory()) return null
  } catch {
    // A route without an extension is handled by the static SPA fallback.
  }

  // Next's app router has a single root route in this project.  Falling back
  // only for extensionless paths keeps missing asset requests as 404s.
  if (path.extname(relative)) return null
  const fallback = path.join(root, 'index.html')
  try {
    const stat = await fs.stat(fallback)
    if (stat.isFile() && isWithinRoot(fallback)) return fallback
  } catch {
    // Report a normal 404 below when the export is missing.
  }
  return null
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method Not Allowed')
    return
  }

  let pathname
  try {
    pathname = requestPath(request.url || '/')
  } catch {
    sendText(response, 400, 'Bad Request')
    return
  }

  if (pathname === '/__health') {
    try {
      const stat = await fs.stat(path.join(root, 'index.html'))
      sendJson(response, 200, {
        ok: stat.isFile(),
        root,
        indexBytes: stat.size,
      })
    } catch {
      sendJson(response, 503, { ok: false, root, reason: 'out/index.html is missing' })
    }
    return
  }

  const file = await resolveFile(pathname)
  if (!file) {
    sendText(response, 404, 'Not Found')
    return
  }

  try {
    const stat = await fs.stat(file)
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-length': stat.size,
      'content-type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const body = await fs.readFile(file)
    response.end(body)
  } catch {
    sendText(response, 500, 'Failed to read static asset')
  }
})

server.on('error', (error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

server.listen(port, host, () => {
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  console.log(`life-timeline static preview: http://${host}:${boundPort}/`)
  console.log(`health: http://${host}:${boundPort}/__health`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

