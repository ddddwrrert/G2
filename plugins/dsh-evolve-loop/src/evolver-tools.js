/**
 * Checkpoint tool: Evolver decision, and the ACT inner loop when a direction matches.
 *
 * @module dsh-evolve-loop/evolver-tools
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { budgetReport } from './budget.js'
import { runPaths } from './candidates.js'
import { decide, signalsFromRows } from './evolver.js'
import { loadHarness } from './harness.js'
import { runInnerLoop } from './inner-loop.js'
import { loadMetaSkill } from './meta-skill.js'
import { readPopulation } from './population.js'
import { recall } from './search-library.js'
import { loadTrial, STATES } from './trial.js'

const MIN_ROWS_BETWEEN_ACTS = 12

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * @param {object} ctx
 * @param {import('./evolve.js').Evolve} evolve
 */
export function registerEvolverTools(ctx, evolve) {
  ctx.tools.register(defineTool({
    name: 'evolve_checkpoint',
    description:
      'Read the recent search trajectory and apply the frozen Meta-Skill. '
      + 'HOLD leaves the harness unchanged. AVOID refuses a forbidden edit. '
      + 'ACT opens a short inner loop: a few harness patches resume from the current population, '
      + 'each spends the same small candidate budget, and a patch is kept only when its official-score '
      + 'gain beats doing nothing. Existing best candidates are not wiped. Model weights are not updated. '
      + 'Call this between evolve_run chunks when progress stalls. Pass the same max_budget as evolve_run.',
    parameters: {
      max_budget: {
        type: 'integer',
        required: true,
        description: 'Pinned run max_budget, the same value passed to evolve_run.',
      },
      window: {
        type: 'integer',
        description: 'How many recent population rows to diagnose. Default 4.',
      },
      per_arm: {
        type: 'integer',
        description: 'New candidates each inner-loop arm may create, including the do-nothing arm. Default 2.',
      },
      max_patches: {
        type: 'integer',
        description: 'How many non-empty patches to race. Default 2.',
      },
      margin: {
        type: 'number',
        description: 'A patch must beat the do-nothing score by more than this. Default 0.',
      },
      max_population: { type: 'integer', description: 'Forwarded to each inner-loop evolve run.' },
      k: { type: 'integer', description: 'Forwarded survive-k for each inner-loop evolve run.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'Harness checkpoint', kind: 'edit' }),
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('evolve_checkpoint needs an Agent-backed session')
      if (evolve.running) throw new Error('an evolve run is in progress; checkpoint between evolve_run calls')
      const { root } = runPaths(exec.agent)
      const trial = await loadTrial(root)
      if (trial.state !== STATES.idle) {
        throw new Error('a provider trial is open; finish it before a harness checkpoint')
      }
      const budget = await budgetReport(root)
      if (budget === null) {
        throw new Error('no run budget yet; call evolve_run once before evolve_checkpoint')
      }
      if (budget.max !== args.max_budget) {
        throw new Error(`max_budget must match the pinned run budget ${String(budget.max)}`)
      }

      const window = args.window ?? 4
      const rows = await readPopulation(root)
      const signals = signalsFromRows(rows, window)
      const skill = await loadMetaSkill(root)
      const decision = decide(signals, skill)
      const harness = await loadHarness(root)

      if (decision.decision === 'ACT') {
        const prior = await priorActs(root)
        const last = prior[prior.length - 1]
        if (last && rows.length - (last.rows_at ?? 0) < MIN_ROWS_BETWEEN_ACTS) {
          decision.decision = 'HOLD'
          decision.reason = `距上次 ACT 仅 ${String(rows.length - (last.rows_at ?? 0))} 条记录，未满 ${String(MIN_ROWS_BETWEEN_ACTS)}，保持当前壳`
        } else if (prior.some(row => row.rule_id === decision.rule_id)) {
          decision.decision = 'HOLD'
          decision.reason = `规则 ${decision.rule_id} 已经对照过，本任务不再重复`
        } else {
          const reused = await recall(root, decision.signals?.kind)
          if (reused && (decision.targets ?? []).includes(reused.slot)) {
            decision.targets = [reused.slot]
            decision.recalled = reused.patch_id
          }
        }
      }

      if (decision.decision !== 'ACT') {
        const record = { at: new Date().toISOString(), ...decision }
        await mkdir(join(root, 'evolver'), { recursive: true })
        await appendFile(join(root, 'evolver', 'decisions.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
        return { ...decision, harness, budget }
      }

      const perArm = args.per_arm ?? 2
      const patches = (decision.targets?.length ?? 0) === 0 ? 0 : Math.min(decision.targets.length, args.max_patches ?? 2)
      const need = perArm * (patches + 1)
      if (budget.remaining < need) {
        return {
          decision: 'HOLD',
          reason: `ACT 需要 ${String(need)} 个候选预算，剩余 ${String(budget.remaining)}，改为保持当前壳`,
          direction: decision.direction,
          signals,
          harness,
          budget,
        }
      }

      const raced = await runInnerLoop({
        runDir: root,
        evolve,
        exec,
        maxBudget: args.max_budget,
        decision,
        perArm,
        maxPatches: args.max_patches ?? 2,
        margin: args.margin ?? 0,
        ...(args.max_population === undefined ? {} : { maxPopulation: args.max_population }),
        ...(args.k === undefined ? {} : { k: args.k }),
      })
      return {
        decision: 'ACT',
        direction: decision.direction,
        targets: decision.targets,
        rule_id: decision.rule_id,
        signals,
        ...raced,
        budget: await budgetReport(root),
      }
    },
  }))
}

async function priorActs(root) {
  let raw = ''
  try {
    raw = await readFile(join(root, 'evolver', 'decisions.jsonl'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const acts = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row.decision === 'ACT') acts.push(row)
    } catch {
      // skip a torn line
    }
  }
  return acts
}
