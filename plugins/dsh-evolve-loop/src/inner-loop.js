/**
 * ACT inner loop: race harness patches against a noop continuation.
 * Each arm resumes from the same population snapshot and spends the same
 * small candidate budget. The population and harness change only if a patch
 * beats noop. Model weights are not touched.
 *
 * @module dsh-evolve-loop/inner-loop
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { applyPatch, loadHarness, saveHarness } from './harness.js'
import { armScore, choosePatch, proposePatches } from './evolver.js'
import { readPopulation, writePopulation } from './population.js'
import { remember } from './search-library.js'

/**
 * @param {object} options
 * @param {string} options.runDir
 * @param {import('./evolve.js').Evolve} options.evolve
 * @param {object} options.exec
 * @param {number} options.maxBudget
 * @param {object} options.decision ACT decision with direction and targets
 * @param {number} [options.perArm=2]
 * @param {number} [options.maxPatches=2]
 * @param {number} [options.margin=0]
 * @param {number} [options.maxPopulation]
 * @param {number} [options.k]
 */
export async function runInnerLoop(options) {
  const {
    runDir,
    evolve,
    exec,
    maxBudget,
    decision,
    perArm = 2,
    maxPatches = 2,
    margin = 0,
    maxPopulation,
    k,
  } = options
  if (decision.decision !== 'ACT') {
    throw new Error('inner loop runs only after ACT')
  }
  const baseHarness = await loadHarness(runDir)
  const snapshot = await readPopulation(runDir)
  const patches = proposePatches(decision, maxPatches)
  const arms = []

  for (const patch of patches) {
    await writePopulation(runDir, snapshot)
    await saveHarness(runDir, applyPatch(baseHarness, patch))
    const result = await evolve.run({
      maxBudget,
      candidates: perArm,
      ...(maxPopulation === undefined ? {} : { maxPopulation }),
      ...(k === undefined ? {} : { k }),
    }, exec)
    const after = await readPopulation(runDir)
    arms.push({
      id: patch.id,
      target: patch.target,
      patch,
      score: armScore(snapshot, after),
      after,
      result,
    })
  }

  const winner = choosePatch(arms, margin)
  const chosen = winner ? arms.find(arm => arm.id === winner.id) : null
  if (chosen) {
    await writePopulation(runDir, chosen.after)
    await saveHarness(runDir, applyPatch(baseHarness, chosen.patch))
  } else {
    await writePopulation(runDir, snapshot)
    await saveHarness(runDir, baseHarness)
  }

  const record = {
    at: new Date().toISOString(),
    decision: 'ACT',
    direction: decision.direction,
    rule_id: decision.rule_id,
    kind: decision.signals?.kind,
    rows_at: snapshot.length,
    targets: decision.targets,
    arms: arms.map(arm => ({ id: arm.id, target: arm.target, score: arm.score })),
    committed: chosen?.id ?? null,
  }
  if (chosen) {
    await remember(runDir, {
      admitted: true,
      kind: decision.signals?.kind,
      slot: chosen.target,
      patch_id: chosen.id,
      source: 'checkpoint',
      at: record.at,
    })
  }
  await mkdir(join(runDir, 'evolver'), { recursive: true })
  await appendFile(join(runDir, 'evolver', 'decisions.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  return {
    committed: chosen?.id ?? null,
    harness: await loadHarness(runDir),
    arms: record.arms,
    direction: decision.direction,
  }
}
