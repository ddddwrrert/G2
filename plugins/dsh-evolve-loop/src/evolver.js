/**
 * Evolver: HOLD / AVOID / ACT from a frozen Meta-Skill and recent trajectory signals.
 * ACT carries a direction and the modules the inner loop may edit.
 *
 * @module dsh-evolve-loop/evolver
 */

import { merit } from './population.js'

const PATCHES = {
  validate: {
    id: 'check-constraints',
    target: 'validate',
    op: 'add',
    note: 'Before you finish, check every constraint in the task statement. Do not leave a candidate that violates a stated constraint.',
  },
  mutate: {
    id: 'diverge-approach',
    target: 'mutate',
    op: 'add',
    note: 'Do not copy the parent structure. Change the algorithmic approach, then implement that one change completely.',
  },
  select: {
    id: 'uniform-parent',
    target: 'select',
    op: 'add',
    select_mode: 'uniform',
    note: 'The parent was chosen for exploration. Improve it along a different axis than the obvious local tweak.',
  },
  survive: {
    id: 'keep-stepping-stone',
    target: 'survive',
    op: 'add',
    survive_mode: 'stepping',
    note: 'Keep one alive candidate that top-k would drop if its children have not outscored it.',
  },
  loop: {
    id: 'fork-lineage',
    target: 'loop',
    op: 'add',
    loop_mode: 'fork',
    note: 'On even attempts, start from the alive candidate with the fewest children.',
  },
}

/**
 * Signals over the most recent scored attempts.
 * @param {object[]} rows
 * @param {number} [window=4]
 */
export function signalsFromRows(rows, window = 4) {
  const scored = rows.filter(row => row && row.id !== undefined)
  const recent = scored.slice(-window)
  const prior = scored.slice(0, Math.max(0, scored.length - recent.length))
  const failed = recent.filter(row => !Number.isFinite(row.fitness) || row.fitness === 0).length
  const parents = recent.map(row => row.parent).filter(parent => typeof parent === 'string')
  const counts = new Map()
  for (const parent of parents) counts.set(parent, (counts.get(parent) ?? 0) + 1)
  const top = [...counts.values()].reduce((max, n) => Math.max(max, n), 0)
  const bestRecent = recent.reduce((best, row) => Math.max(best, merit(row.fitness)), 0)
  const bestPrior = prior.reduce((best, row) => Math.max(best, merit(row.fitness)), 0)
  const flat = prior.length === 0
    ? recent.length >= 2 && recent.every(row => merit(row.fitness) === merit(recent[0].fitness))
    : bestRecent <= bestPrior
  const merits = recent.map(row => merit(row.fitness))
  const identical = merits.length >= 2 && merits.every(value => value === merits[0])
  const failedRate = recent.length === 0 ? 0 : failed / recent.length
  const sameParentRate = parents.length === 0 ? 0 : top / parents.length
  const signals = {
    n: recent.length,
    failed_rate: failedRate,
    same_parent_rate: sameParentRate,
    flat,
    identical,
    advancing: prior.length > 0 && bestRecent > bestPrior,
  }
  signals.kind = classifyKind(signals)
  return signals
}

/**
 * One label for the recent window. Population rows are the only input:
 * hidden final scores (run/final.txt) are not read.
 * @param {object} signals
 */
export function classifyKind(signals) {
  if (signals.n < 3) return 'thin'
  if (signals.failed_rate >= 0.5) return 'failing'
  if (signals.identical) return 'identical'
  if (signals.same_parent_rate >= 0.75 && signals.flat) return 'collapsed'
  if (signals.flat) return 'noisy_stall'
  return 'advancing'
}

function matches(when, signals) {
  if (!when) return true
  if (when.min_n !== undefined && signals.n < when.min_n) return false
  if (when.failed_rate_gte !== undefined && !(signals.failed_rate >= when.failed_rate_gte)) return false
  if (when.same_parent_rate_gte !== undefined && !(signals.same_parent_rate >= when.same_parent_rate_gte)) return false
  if (when.flat === true && signals.flat !== true) return false
  if (when.kind !== undefined && signals.kind !== when.kind) return false
  return true
}

/**
 * @param {object} signals
 * @param {object} skill
 */
export function decide(signals, skill) {
  if (signals.n < 3) {
    return { decision: 'HOLD', reason: skill.hold, signals }
  }
  if (signals.kind === 'advancing' || signals.kind === 'noisy_stall' || signals.kind === 'thin') {
    return { decision: 'HOLD', reason: skill.hold, signals }
  }
  for (const rule of skill.act ?? []) {
    if (!matches(rule.when, signals)) continue
    const blocked = new Set((skill.avoid ?? []).flatMap(item => item.targets ?? []))
    const targets = (rule.targets ?? []).filter(target => !blocked.has(target))
    if (targets.length === 0) {
      const why = (skill.avoid ?? []).find(item => (rule.targets ?? []).some(target => (item.targets ?? []).includes(target)))
      return {
        decision: 'AVOID',
        reason: why?.reason ?? '这条改法被 Meta-Skill 禁止',
        rule_id: rule.id,
        signals,
      }
    }
    return {
      decision: 'ACT',
      direction: rule.direction,
      targets: targets,
      rule_id: rule.id,
      signals,
    }
  }
  return { decision: 'HOLD', reason: skill.hold, signals }
}

/**
 * Patches the inner loop may race. Always includes a noop baseline.
 * @param {{ targets?: string[] }} decision
 * @param {number} [limit=2]
 */
export function proposePatches(decision, limit = 2) {
  const patches = [{ id: 'noop', target: 'none', op: 'noop' }]
  for (const target of decision.targets ?? []) {
    const patch = PATCHES[target]
    if (patch && patches.length < limit + 1) patches.push({ ...patch })
  }
  return patches
}

/**
 * Strict improvement first, then saturating partial credit in [0, 1).
 * A gain scores at least 1; no gain scores below 1.
 * @param {object[]} beforeRows
 * @param {object[]} afterRows
 */
export function armScore(beforeRows, afterRows) {
  const beforeBest = beforeRows.reduce((best, row) => Math.max(best, merit(row.fitness)), 0)
  const afterBest = afterRows.reduce((best, row) => Math.max(best, merit(row.fitness)), 0)
  const gained = afterRows.slice(beforeRows.length)
  const useful = gained.filter(row => merit(row.fitness) > beforeBest).length
  const partial = gained.length === 0 ? 0 : useful / gained.length
  const bounded = partial / (partial + 1)
  return (afterBest > beforeBest ? 1 : 0) + bounded
}

/**
 * Commit a patch only when it beats the noop arm by more than margin.
 * @param {{ id: string, score: number }[]} arms
 * @param {number} [margin=0]
 */
export function choosePatch(arms, margin = 0) {
  const noop = arms.find(arm => arm.id === 'noop')
  const ranked = [...arms].filter(arm => arm.id !== 'noop').sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (!best || !noop) return null
  if (best.score > noop.score + margin) return best
  return null
}
