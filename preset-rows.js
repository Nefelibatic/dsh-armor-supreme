// preset-rows.js — 「破甲·至强」预设行
//
// 两条路子，按宿主能力自动选：
//
//   1) 宿主活体克隆（首选）。宿主把 `standard` 预设注册进了 agentPresets，
//      `registry.definitions.get('standard').config.plugins` 就是**这台机器当前
//      版本**解析过的行列表（`!!js` 也已经求值成表达式对象）。直接深拷贝过来，
//      只按 id 覆盖我们要改的几项，再追加本插件自己的注入行 —— 这样宿主升级
//      换了包名、删了子路径、加了新工具，我们都不用跟着改。
//
//   2) 静态兜底。宿主还没注册 standard（启动早期的时序），或用的是不提供
//      standard 的发行版，就用下面这份按 dsh 0.2.1-rc.2 抄的完整行列表。
//
// 不管走哪条，注册失败时还会走「诊断剪枝」：把宿主报 `never started` 的行摘掉
// 再注册一次（见 index.js 的 declarePreset）。所以单一版本假设不会把整张预设
// 卡拖成 broken。

const IS_WIN = process.platform === 'win32'

/** 本插件注入行的 id，index.js 靠它把「预设实例」和「常驻实例」分开。 */
export const ARMOR_ROW_ID = 'armor-supreme-core'

/**
 * 按 entry id 覆盖宿主行。只改真正需要改的，其余原样继承。
 * - persona：破甲模式下不写"你是一个有帮助的编程助手"这类引导句，身份交给 armor:register 段。
 * - tool-result-pruner：本插件提示词约 5 万字符，阈值放宽，避免长交付被腰斩成"回退式降级"。
 */
const OVERRIDES = {
  persona: { config: { prefix: '' } },
  'tool-result-pruner': {
    config: { thresholdChars: 32768, headChars: 8192, tailChars: 2048 },
  },
}

const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

/** 静态兜底行（对齐 dsh 0.2.1-rc.2 的 presets/standard.patch.yml）。 */
export const ROWS = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: { prefix: '' },
  },
  {
    id: 'agent-instructions',
    name: '@deepseek-ai/dsh-agent-instructions',
    config: { maxBytes: 65536 },
  },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },

  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: IS_WIN },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !IS_WIN },

  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  {
    id: 'tool-fs-search',
    name: '@deepseek-ai/dsh-tool-fs-search',
    config: { sampleOverCapGlobResults: false },
  },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },

  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

  {
    id: 'planning',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    config: [
      {
        id: 'plan-mode',
        name: '@deepseek-ai/dsh-plan-mode',
        config: { section: PLAN_MODE_SECTION },
      },
    ],
  },

  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 32768, headChars: 8192, tailChars: 2048 },
      },
    ],
  },

  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      {
        id: 'tool-subagent-list-agents',
        name: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
      },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true },
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' },
      },
      {
        id: 'workflow-ptc',
        name: '@deepseek-ai/dsh-workflow-ptc',
        config: { provider: 'spawn' },
      },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ],
  },

  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  {
    id: 'tool-todo',
    name: '@deepseek-ai/dsh-tool-todo',
    config: { allowParallelInProgress: true },
  },
  {
    id: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    config: { fetch: true, searchTimeoutMs: 60000 },
  },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
]

/** 本插件自己的注入行（永远追加在最后）。 */
export function armorRow() {
  return {
    // id 必须与 index.js 的 ARMOR_ROW_ID 一致：插件靠 config.via === 'preset'
    // 判断"自己是被选中的破甲预设装上的"，而不是常驻实例。
    id: ARMOR_ROW_ID,
    name: 'dsh-armor-supreme',
    config: { via: 'preset', enabled: true },
  }
}

/**
 * JSON 深拷贝。宿主的行来自 YAML 解析，值是普通数据（`!!js` 已经变成
 * `{ __jsExpr: '...' }` 对象），JSON 往返足以保住语义；反倒 structuredClone
 * 会拒绝对某些注入过的对象图下手，没必要。
 */
export function cloneRows(rows) {
  if (!Array.isArray(rows)) return []
  try {
    return JSON.parse(JSON.stringify(rows))
  } catch {
    return []
  }
}

/**
 * 组的判定只看 `config` 是不是数组。
 *
 * 宿主 standard.patch.yml 里的组是 `- id: planning` / `name: cordis:group` /
 * `config: [ ...子行 ]`，**没有** `group: true` 这种字段（那是 cordis 内部归一化
 * 之后才可能有的东西）。早先按 `row.group === true` 判断，结果组里的
 * `tool-result-pruner` 覆盖不到、坏行也剪不掉 —— 换版时整卡照样 broken。
 */
function isGroupRow(row) {
  return !!row && typeof row === 'object' && Array.isArray(row.config)
}

/** 递归按 id 应用覆盖，返回命中数。config 是普通对象时做浅合并，不整个替换。 */
function applyOverrides(rows) {
  let hit = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const patch = row.id ? OVERRIDES[row.id] : undefined
    if (patch) {
      const next = cloneRows([patch])[0]
      const rowCfg = row.config
      const nextCfg = next && next.config
      if (
        nextCfg && typeof nextCfg === 'object' && !Array.isArray(nextCfg) &&
        rowCfg && typeof rowCfg === 'object' && !Array.isArray(rowCfg)
      ) {
        row.config = { ...rowCfg, ...nextCfg }
        delete next.config
      }
      Object.assign(row, next)
      hit += 1
    }
    if (isGroupRow(row)) hit += applyOverrides(row.config)
  }
  return hit
}

/**
 * 从宿主活体注册表里克隆 standard 预设的行。
 * @param {unknown} registry agentPresets 服务
 * @returns {{ rows: object[], from: string } | null}
 */
export function hostStandardRows(registry) {
  const defs = registry && registry.definitions
  if (!defs || typeof defs.get !== 'function') return null
  for (const id of ['standard', 'preset-standard', 'default']) {
    let record
    try {
      record = defs.get(id)
    } catch {
      record = undefined
    }
    const plugins = record && record.config && record.config.plugins
    if (Array.isArray(plugins) && plugins.length > 0) {
      return { rows: cloneRows(plugins), from: id }
    }
  }
  return null
}

/**
 * 组装本次要注册的行列表。
 * @param {unknown} registry agentPresets 服务（可为 undefined）
 * @returns {{ rows: object[], source: string }}
 */
export function buildRows(registry) {
  const host = hostStandardRows(registry)
  if (host) {
    const rows = host.rows
    applyOverrides(rows)
    rows.push(armorRow())
    return { rows, source: `host:${host.from}` }
  }
  const rows = cloneRows(ROWS)
  rows.push(armorRow())
  return { rows, source: 'static' }
}

const BROKEN_ROW = /^(.+?) \((.+?)\): (.*)$/

/**
 * 从注册表诊断文本里认出「硬失败」的行 id。
 *
 * 诊断行形如 `tool-subagent-list-agents (@deepseek-ai/dsh-tool-.../list-agents): never started`。
 * `waiting for <service>` 是**待定**而非失败（宿主服务稍后就位会自愈），不剪。
 * @param {string} text registry.diagnostic() 的返回值
 * @returns {{ id: string, name: string, reason: string }[]}
 */
export function brokenRowsOf(text) {
  const out = []
  if (typeof text !== 'string' || text === '') return out
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^-\s*/, '')
    if (line === '') continue
    if (/waiting for/i.test(line)) continue
    const m = BROKEN_ROW.exec(line)
    if (!m) continue
    const id = m[1].trim()
    const name = m[2].trim()
    const reason = m[3].trim()
    if (id === '' || id === 'undefined' || id === 'null') continue
    out.push({ id, name, reason })
  }
  return out
}

/**
 * 从行树里摘掉指定 id 的行；组被摘空就一并摘掉。返回新树与被摘清单。
 * @param {object[]} rows
 * @param {Set<string>} ids 要摘的 entry id
 * @param {string[]} [dropped] 累加被摘的 id
 */
export function pruneRows(rows, ids, dropped = []) {
  const kept = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (row.id && ids.has(row.id)) {
      dropped.push(row.id)
      continue
    }
    if (isGroupRow(row)) {
      const children = pruneRows(row.config, ids, dropped)
      if (children.length === 0) {
        if (row.id) dropped.push(row.id)
        continue
      }
      row.config = children
    }
    kept.push(row)
  }
  return kept
}
