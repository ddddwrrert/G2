/**
 * Default population survival provider: keeps the top k alive candidates.
 *
 * @module dsh-evolve-loop/providers/survive
 */

import { loadHarness } from '../harness.js'
import { alive, merit } from '../population.js'

export const name = 'top-k'
export const DEFAULT_K = 5

/**
 * Cull the population down to the top k alive candidates, ranked by merit().
 * @param {object} population - the population handle.
 * @param {object} evolve - the evolve service.
 */
export async function survive(population, evolve) {
  const { k } = await evolve.context()
  const rows = await population.rows()
  const pool = alive(rows)
  const ranked = pool.sort((a, b) => merit(b.fitness) - merit(a.fitness))
  const survivors = new Set(ranked.slice(0, k ?? DEFAULT_K).map(r => r.id))
  const root = evolve?.currentRun?.()?.root
  if (typeof root === 'string' && (await loadHarness(root)).survive_mode === 'stepping') {
    const extra = pool.filter(row => !survivors.has(row.id) && isSteppingStone(row, rows))
    extra.sort((a, b) => merit(a.fitness) - merit(b.fitness))
    if (extra[0]) survivors.add(extra[0].id)
  }

  await population.write(rows.map(row => (
    row.survival === 'yes' && !survivors.has(row.id) ? { ...row, survival: 'no' } : row
  )))
}

function isSteppingStone(row, rows) {
  const children = rows.filter(child => child.parent === row.id)
  if (children.length === 0) return false
  return children.every(child => merit(child.fitness) <= merit(row.fitness))
}

export default { name, survive }
