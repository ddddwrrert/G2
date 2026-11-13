import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decide, proposePatches, signalsFromRows, armScore, choosePatch } from '../src/evolver.js'
import { applyPatch, loadHarness, seedHarness } from '../src/harness.js'
import { runInnerLoop } from '../src/inner-loop.js'
import { DEFAULT_META_SKILL } from '../src/meta-skill.js'
import { appendPopulation, readPopulation } from '../src/population.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../.test-runs/', import.meta.url))

let tmpDir: string
let runDir: string

beforeEach(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  tmpDir = await realpath(await mkdtemp(join(FIXTURE_ROOT, 'evolver-')))
  runDir = join(tmpDir, 'run')
  await mkdir(runDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('evolver decisions', () => {
  it('holds when there are too few attempts', () => {
    const signals = signalsFromRows([
      { id: 'c000000', parent: null, fitness: 0 },
      { id: 'c000001', parent: 'c000000', fitness: 0 },
    ])
    expect(decide(signals, DEFAULT_META_SKILL).decision).toBe('HOLD')
  })

  it('acts on repeated failed evaluations with a validate direction', () => {
    const signals = signalsFromRows([
      { id: 'c000001', parent: 'c000000', fitness: 0 },
      { id: 'c000002', parent: 'c000001', fitness: 0 },
      { id: 'c000003', parent: 'c000002', fitness: 0 },
      { id: 'c000004', parent: 'c000003', fitness: 0 },
    ])
    const decision = decide(signals, DEFAULT_META_SKILL)
    expect(decision).toMatchObject({
      decision: 'ACT',
      rule_id: 'missing-checks',
      targets: ['validate'],
    })
    expect(decision.direction).toMatch(/约束/)
    expect(proposePatches(decision).map(patch => patch.id)).toEqual(['noop', 'check-constraints'])
  })

  it('holds a noisy stall and acts on identical scores through survive', () => {
    const noisy = signalsFromRows([
      { id: 'c000000', parent: null, fitness: 10 },
      { id: 'c000001', parent: 'c000000', fitness: 4 },
      { id: 'c000002', parent: 'c000001', fitness: 6 },
      { id: 'c000003', parent: 'c000002', fitness: 5 },
      { id: 'c000004', parent: 'c000003', fitness: 3 },
    ])
    expect(noisy.kind).toBe('noisy_stall')
    expect(decide(noisy, DEFAULT_META_SKILL).decision).toBe('HOLD')

    const identical = signalsFromRows([
      { id: 'c000001', parent: 'c000000', fitness: 5 },
      { id: 'c000002', parent: 'c000000', fitness: 5 },
      { id: 'c000003', parent: 'c000000', fitness: 5 },
      { id: 'c000004', parent: 'c000000', fitness: 5 },
    ])
    expect(identical.kind).toBe('identical')
    const decision = decide(identical, DEFAULT_META_SKILL)
    expect(decision).toMatchObject({ decision: 'ACT', rule_id: 'identical-scores', targets: ['survive'] })
    expect(proposePatches(decision).map(patch => patch.id)).toEqual(['noop', 'keep-stepping-stone'])
  })

  it('avoids an act rule whose only target is forbidden', () => {
    const skill = {
      hold: 'keep',
      avoid: [{ id: 'no-eval', targets: ['evaluate'], reason: '评分器不动' }],
      act: [{
        id: 'touch-eval',
        when: { min_n: 1, failed_rate_gte: 0 },
        direction: '改评分器',
        targets: ['evaluate'],
      }],
    }
    const signals = signalsFromRows([
      { id: 'a', fitness: 0 },
      { id: 'b', fitness: 0 },
      { id: 'c', fitness: 0 },
    ])
    expect(decide(signals, skill)).toMatchObject({ decision: 'AVOID', reason: '评分器不动' })
  })

  it('keeps a patch only when it beats doing nothing', () => {
    expect(choosePatch([
      { id: 'noop', score: 0.4 },
      { id: 'check-constraints', score: 1.2 },
    ])?.id).toBe('check-constraints')
    expect(choosePatch([
      { id: 'noop', score: 1.1 },
      { id: 'check-constraints', score: 1.1 },
    ])).toBeNull()
  })

  it('scores a real gain at or above 1 and a flat arm below 1', () => {
    const before = [{ id: 'c000000', fitness: 10 }]
    expect(armScore(before, [...before, { id: 'c000001', fitness: 12 }])).toBeGreaterThanOrEqual(1)
    expect(armScore(before, [...before, { id: 'c000001', fitness: 10 }])).toBeLessThan(1)
  })
})

describe('ACT inner loop on the existing population', () => {
  it('commits the patch that improves fitness and leaves a losing arm out of the population', async () => {
    await appendPopulation(runDir, { id: 'c000000', parent: null, fitness: 0, survival: 'yes' })
    await appendPopulation(runDir, { id: 'c000001', parent: 'c000000', fitness: 0, survival: 'yes' })
    await appendPopulation(runDir, { id: 'c000002', parent: 'c000001', fitness: 0, survival: 'yes' })
    await appendPopulation(runDir, { id: 'c000003', parent: 'c000002', fitness: 0, survival: 'yes' })

    let serial = 4
    const evolve = {
      async run() {
        const harness = await loadHarness(runDir)
        const rows = await readPopulation(runDir)
        const parent = rows[rows.length - 1]
        const helped = (harness.mutate_notes ?? []).length > 0
        const id = `c${String(serial).padStart(6, '0')}`
        serial += 1
        await appendPopulation(runDir, {
          id,
          parent: parent.id,
          fitness: helped ? 15 : 0,
          survival: 'yes',
        })
        return { best_id: id, best_fitness: helped ? 15 : 0, remaining: 0 }
      },
    }

    const decision = decide(signalsFromRows(await readPopulation(runDir)), DEFAULT_META_SKILL)
    const raced = await runInnerLoop({
      runDir,
      evolve,
      exec: {},
      maxBudget: 20,
      decision,
      perArm: 1,
    })

    expect(raced.committed).toBe('check-constraints')
    const rows = await readPopulation(runDir)
    expect(rows.map(row => row.id)).toEqual(['c000000', 'c000001', 'c000002', 'c000003', 'c000005'])
    expect(rows.at(-1)?.fitness).toBe(15)
    const harness = await loadHarness(runDir)
    expect(harness.mutate_notes[0]).toMatch(/constraint/)
    expect(harness.applied[0].scope).toBe('rest_of_task')
    const log = await readFile(join(runDir, 'evolver', 'decisions.jsonl'), 'utf8')
    expect(log).toContain('"committed":"check-constraints"')
  })

  it('applyPatch does not drop the seed fields', () => {
    const next = applyPatch(seedHarness(), {
      id: 'check-constraints',
      target: 'validate',
      op: 'add',
      note: 'check',
    })
    expect(next.select_mode).toBe('fitness')
    expect(next.mutate_notes).toEqual(['check'])
  })
})
