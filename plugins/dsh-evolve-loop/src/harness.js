/**
 * Run-local search harness. The workflow (how select/mutate are instructed)
 * lives inside this shell. Patches apply only to the rest of the current task.
 *
 * @module dsh-evolve-loop/harness
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HARNESS_FILE = 'harness.json'

export function seedHarness() {
  return {
    schema_version: 1,
    select_mode: 'fitness',
    mutate_notes: [],
    applied: [],
  }
}

/**
 * @param {string} runDir
 */
export async function loadHarness(runDir) {
  try {
    const raw = JSON.parse(await readFile(join(runDir, HARNESS_FILE), 'utf8'))
    return {
      ...seedHarness(),
      ...raw,
      mutate_notes: Array.isArray(raw.mutate_notes) ? raw.mutate_notes : [],
      applied: Array.isArray(raw.applied) ? raw.applied : [],
    }
  } catch (error) {
    if (error.code === 'ENOENT') return seedHarness()
    throw error
  }
}

/**
 * @param {string} runDir
 * @param {object} harness
 */
export async function saveHarness(runDir, harness) {
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, HARNESS_FILE), `${JSON.stringify(harness, null, 2)}\n`, 'utf8')
}

/**
 * Copy a harness and apply one local patch. Does not touch population or budget.
 * @param {object} harness
 * @param {object} patch
 */
export function applyPatch(harness, patch) {
  const next = {
    ...harness,
    mutate_notes: [...(harness.mutate_notes ?? [])],
    applied: [...(harness.applied ?? [])],
  }
  if (patch.op === 'noop') return next
  if (patch.select_mode) next.select_mode = patch.select_mode
  if (patch.survive_mode) next.survive_mode = patch.survive_mode
  if (patch.loop_mode) next.loop_mode = patch.loop_mode
  if (typeof patch.note === 'string' && patch.note !== '' && !next.mutate_notes.includes(patch.note)) {
    next.mutate_notes.push(patch.note)
  }
  next.applied.push({
    id: patch.id,
    target: patch.target,
    at: new Date().toISOString(),
    scope: 'rest_of_task',
  })
  return next
}
