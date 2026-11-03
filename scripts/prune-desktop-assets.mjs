#!/usr/bin/env node

/**
 * Remove source-only handoff material from a generated frontendDist.
 *
 * The historical ZIPs remain in `public/` for audit/reference. This script
 * only ever removes their copies under `out/` (or another generated staging
 * directory supplied through STATIC_ROOT); it refuses to operate on public/.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(process.env.STATIC_ROOT || path.join(projectRoot, 'out'))
const publicRoot = path.resolve(path.join(projectRoot, 'public'))

function isWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}

if (isWithin(root, publicRoot)) {
  console.error(`Refusing to prune source public/ tree: ${root}`)
  process.exit(2)
}

const historicalHandoffFiles = new Set([
  'Life_Timeline_v0_Account_Migration_Handoff_R1_20260819.zip',
  'life-timeline-handoff.zip',
  'life-timeline-handoff-R3.zip',
])

// Keep this list deliberately narrow: arbitrary public media must never be
// guessed to be a test fixture and silently removed from a desktop build.
const testArtifactDirectoryNames = new Set(['test-assets', 'test-fixtures', 'e2e-artifacts'])

const removed = []

async function walk(directory) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (testArtifactDirectoryNames.has(entry.name.toLowerCase())) {
        await fs.rm(candidate, { recursive: true, force: true })
        removed.push(path.relative(root, candidate))
        continue
      }
      await walk(candidate)
      continue
    }
    if (entry.isFile() && historicalHandoffFiles.has(entry.name)) {
      await fs.rm(candidate, { force: true })
      removed.push(path.relative(root, candidate))
    }
  }
}

try {
  await fs.stat(root)
} catch {
  console.error(`Generated frontendDist does not exist: ${root}`)
  process.exit(2)
}

await walk(root)
console.log(`desktop asset prune: ${removed.length} removed from ${path.relative(projectRoot, root) || '.'}`)
for (const item of removed) console.log(`- ${item}`)

