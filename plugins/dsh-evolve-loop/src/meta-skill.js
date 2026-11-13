/**
 * Frozen textual Meta-Skill: when the evolver may edit the harness.
 * A run may override this with run/meta-skill.json. Weights are never updated here.
 *
 * @module dsh-evolve-loop/meta-skill
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const META_SKILL_FILE = 'meta-skill.json'

/** Hand-written starter. Distillation is optional and not required to run. */
export const DEFAULT_META_SKILL = Object.freeze({
  schema_version: 1,
  hold: '样本不足，或分数仍在前进，保持当前壳。',
  avoid: [
    {
      id: 'no-evaluator',
      targets: ['evaluate'],
      reason: '不要改官方评测器。',
    },
  ],
  act: [
    {
      id: 'missing-checks',
      when: { min_n: 3, failed_rate_gte: 0.5 },
      direction: '反复出现失败评测，交卷前补上约束检查',
      targets: ['validate'],
    },
    {
      id: 'homogeneous',
      when: { min_n: 3, kind: 'collapsed' },
      direction: '父代重复且分数平台，加大变异并放宽选父',
      targets: ['mutate', 'select'],
    },
    {
      id: 'identical-scores',
      when: { min_n: 3, kind: 'identical' },
      direction: '分数完全相同，淘汰时留一个尚未被子代超过的个体',
      targets: ['survive'],
    },
  ],
})

/**
 * @param {string} runDir
 */
export async function loadMetaSkill(runDir) {
  try {
    const raw = JSON.parse(await readFile(join(runDir, META_SKILL_FILE), 'utf8'))
    return {
      ...DEFAULT_META_SKILL,
      ...raw,
      act: Array.isArray(raw.act) ? raw.act : DEFAULT_META_SKILL.act,
      avoid: Array.isArray(raw.avoid) ? raw.avoid : DEFAULT_META_SKILL.avoid,
    }
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(DEFAULT_META_SKILL)
    throw error
  }
}
