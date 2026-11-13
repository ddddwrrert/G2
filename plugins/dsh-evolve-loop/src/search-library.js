/**
 * Certificates that survived a contrast, stored beside the task so a later
 * run can propose the same slot again. Recall never installs a patch:
 * the caller still has to beat the do-nothing arm.
 *
 * @module dsh-evolve-loop/search-library
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const LIBRARY_FILE = 'search-library.jsonl'

/**
 * @param {string} runDir
 */
export function libraryPath(runDir) {
  return join(dirname(runDir), LIBRARY_FILE)
}

/**
 * Latest admitted certificate for this signal kind.
 * @param {string} runDir
 * @param {string} kind
 */
export async function recall(runDir, kind) {
  let raw = ''
  try {
    raw = await readFile(libraryPath(runDir), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let hit = null
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.admitted === true && row.kind === kind && typeof row.slot === 'string') hit = row
  }
  return hit
}

/**
 * @param {string} runDir
 * @param {object} certificate
 */
export async function remember(runDir, certificate) {
  if (certificate?.admitted !== true || typeof certificate.kind !== 'string') return
  const path = libraryPath(runDir)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(certificate)}\n`, 'utf8')
}
