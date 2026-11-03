#!/usr/bin/env node

/** Check a Next.js static export without starting a server. */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(process.env.STATIC_ROOT || path.join(projectRoot, 'out'))
const indexPath = path.join(root, 'index.html')
const errors = []

function insideRoot(candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function localPath(reference) {
  if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return null
  if (/^https?:\/\//i.test(reference)) return null
  if (!reference.startsWith('/')) {
    errors.push(`asset reference is not root-relative: ${reference}`)
    return null
  }
  const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0])
  const candidate = path.resolve(root, pathname.slice(1))
  if (!insideRoot(candidate)) {
    errors.push(`asset reference escapes out/: ${reference}`)
    return null
  }
  return candidate
}

let index
try {
  index = await fs.readFile(indexPath, 'utf8')
} catch {
  errors.push(`missing ${path.relative(projectRoot, indexPath)}`)
  index = ''
}

const refs = [...index.matchAll(/(?:src|href)="([^"]+)"/gi)].map((match) => match[1])
const localRefs = refs.map(localPath).filter(Boolean)
for (const candidate of localRefs) {
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) errors.push(`asset is not a file: ${path.relative(root, candidate)}`)
  } catch {
    errors.push(`missing referenced asset: ${path.relative(root, candidate)}`)
  }
}

const externalRefs = [...index.matchAll(/https?:\/\/[^"'\s)]+/gi)]
  .map((match) => match[0])
  .filter((value) => value !== 'http://www.w3.org/2000/svg')
if (externalRefs.length) errors.push(`external URL in index.html: ${externalRefs.join(', ')}`)

const forbiddenNames = [
  'Life_Timeline_v0_Account_Migration_Handoff_R1_20260819.zip',
  'life-timeline-handoff.zip',
  'life-timeline-handoff-R3.zip',
]
for (const name of forbiddenNames) {
  try {
    await fs.access(path.join(root, name))
    errors.push(`release output contains handoff artifact: ${name}`)
  } catch {
    // Expected for a clean frontendDist.
  }
}

if (errors.length) {
  console.error(`static output check failed (${errors.length} issue${errors.length === 1 ? '' : 's'})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`static output check passed: ${path.relative(projectRoot, root) || '.'}`)
  console.log(`index references checked: ${localRefs.length}`)
}

