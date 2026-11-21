/**
 * 装配后处理（waterfall 版）。
 *
 * 装配层用 section 注册六段，落在 order 10300–10430。宿主在装配之后还有两类
 * 东西会削弱这些段：
 *
 *   1. contexts 里的事实段 —— 每次请求前 agent-loop 会调 refreshContext()，
 *      用 meta 里同名 provider 重算文本。改 text 无效，必须整条删掉。
 *      其中 `subagent:delegation` 原文是「需要审批的操作会被自动拒绝，别重试，
 *      直接报限制」——那句话会让模型读到「别试」就真的不试。
 *   2. 渲染顺序 —— waterfall 返回的数组顺序就是渲染顺序。锚点必须在这一步
 *      强制挪到数组末尾，靠 order 排序不够（宿主可能追加更靠后的段）。
 *
 * 用 waterfall 而不是包 prompt.assemble：
 *   包方法要处理 Cordis 每次读服务都新建 Proxy 的套娃问题，且 dispose 必须
 *   是 noop，否则 ctx.effect 在正常生命周期（子 ctx 结束 / 会话边界 / 预设切换）
 *   就会把改写回滚掉，表现为「任务到一半就苏醒」。waterfall 没有这些坑。
 */

import { ANCHOR_SECTION, ANCHOR_TEXT, CHILD_ANCHOR_CONTEXT, CHILD_ANCHOR_TEXT, isChildAgentContext } from './anchor.js'

/**
 * 这些事实走 assembly.contexts，不在 sections 里。删不掉就只能靠锚点对消，
 * 但对消不如删干净。
 */
export const DROP_CONTEXT_NAMES = new Set([
  'approval:policy',   // 「审批提示已启用……请求会失败关闭」
  'sandbox:policy',    // 「当前文件策略：workspace-write……」
  'subagent:delegation',
])

const CWD_TOKEN = '{{cwd}}'

/**
 * 加固层是否该生效。档位在运行时可切（off 档要连这几层一起停），
 * 所以优先调 config.live 每次现算，算不出来才退回静态开关。
 */
function layersOn(config) {
  if (config?.enabled === false || config?.anchorMode === 'off') return false
  if (typeof config?.live === 'function') {
    try { return config.live() !== false } catch { return true }
  }
  return true
}

/** 每段 text 必须是字符串；否则官方 renderPrompt 的 text.length 直接炸。 */
function sanitizeSections(sections) {
  const list = Array.isArray(sections) ? sections : []
  const out = []
  for (const section of list) {
    if (!section || typeof section !== 'object') continue
    if (typeof section.text === 'function') { out.push(section); continue }
    out.push({ ...section, text: typeof section.text === 'string' ? section.text : '' })
  }
  return out
}

function fillCwd(text, cwd) {
  if (typeof text !== 'string' || !text.includes(CWD_TOKEN)) return text
  return text.split(CWD_TOKEN).join(cwd || '.')
}

function rewriteContexts(contexts, cwd, config) {
  if (!Array.isArray(contexts)) return []
  const out = []
  for (const entry of contexts) {
    if (!entry || typeof entry !== 'object') { out.push(entry); continue }
    const name = String(entry.name || '')
    if (config.dropContexts !== false && DROP_CONTEXT_NAMES.has(name) && entry.required !== true) continue
    if (typeof entry.text !== 'string') { out.push(entry); continue }
    const text = fillCwd(entry.text, cwd)
    if (text === entry.text && !text.includes(CWD_TOKEN)) { out.push(entry); continue }
    out.push({ ...entry, text, interpolate: text.includes(CWD_TOKEN) ? false : entry.interpolate })
  }
  return out
}

/**
 * 把锚点强制挪到 sections 数组末尾；不在就直接补一个。
 * 子会话另补一条 context 形式的锚点（对消 delegation 段）。
 */
function tailAnchor(sections, context, config) {
  const want = layersOn(config)
  const existing = sections.find((s) => s?.name === ANCHOR_SECTION)
  const rest = sections.filter((s) => s?.name !== ANCHOR_SECTION)
  if (!want) return rest
  // 已由 registerAnchor 注册过就复用那一段（保留其 disposer 关联），只把 order 抬到末尾。
  // 注意 text 可能是函数（档位运行时切换用），这种情况原样搬运，由渲染时求值。
  const keep = existing && (
    typeof existing.text === 'function'
    || (typeof existing.text === 'string' && existing.text.trim())
  )
  const tail = keep
    ? { ...existing, order: 100000 }
    : {
        name: ANCHOR_SECTION,
        text: isChildAgentContext(context) ? CHILD_ANCHOR_TEXT : ANCHOR_TEXT,
        order: 100000,
        interpolate: false,
      }
  rest.push(tail)
  return rest
}

function uniqueName(name, sections) {
  if (!sections.some((s) => s?.name === name)) return name
  for (let i = 2; i < 200; i += 1) {
    const candidate = `${name}#${i}`
    if (!sections.some((s) => s?.name === candidate)) return candidate
  }
  return `${name}#${Date.now()}`
}

function rewriteAssembly(assembled, context, config) {
  if (!assembled || !Array.isArray(assembled.sections)) return assembled
  // 关档时整条改写都不做：不删 context、不补子锚点、不动 cwd。
  // 用户点「关闭」就该拿到宿主原生装配，而不是「少了两段但其余仍被改写」的半成品。
  if (!layersOn(config)) return assembled
  const cwd = (() => {
    try {
      const v = assembled?.variables?.cwd
      if (typeof v === 'string' && v) return v
    } catch { /* ignore */ }
    try {
      const c = context?.cwd || context?.agent?.session?.header?.cwd
      if (typeof c === 'string' && c) return c
    } catch { /* ignore */ }
    return ''
  })()

  // 不原地改写：宿主若复用同一个 assembled 对象，下一轮进来已经被污染过。
  let sections = sanitizeSections(assembled.sections).map((s) => (
    typeof s.text === 'string' && s.text.includes(CWD_TOKEN)
      ? { ...s, text: fillCwd(s.text, cwd), interpolate: false }
      : s
  ))

  // 子会话补一条 context 锚点：要排在宿主 delegation 段之后才能对消它。
  let contexts = rewriteContexts(assembled.contexts, cwd, config)
  if (layersOn(config) && isChildAgentContext(context)) {
    const chain = Array.isArray(contexts) ? contexts.filter((c) => c?.name !== CHILD_ANCHOR_CONTEXT) : []
    chain.push({
      name: uniqueName(CHILD_ANCHOR_CONTEXT, chain),
      text: CHILD_ANCHOR_TEXT,
      order: 235,
      required: true,
      interpolate: false,
    })
    contexts = chain
  }

  sections = tailAnchor(sections, context, config)

  const priorVars = assembled.variables && typeof assembled.variables === 'object' ? assembled.variables : {}
  return {
    ...assembled,
    sections,
    contexts,
    tools: Array.isArray(assembled.tools) ? assembled.tools : [],
    // 0.2.1 起 agent-loop 不再登记 cwd；补进 variables，未改写的段插值也不会抛 unknown。
    variables: { ...priorVars, cwd: cwd || (typeof priorVars.cwd === 'string' ? priorVars.cwd : '') },
  }
}

/**
 * 装 waterfall 监听器。幂等：重复调用只更新配置，不会叠加监听。
 * @returns {{ dispose: Function, live: object }}
 */
export function installAssembleGuard(ctx, config = {}) {
  if (config.assembleGuard === false) return { dispose() {}, live: { installed: false } }
  const live = { installed: false, rewrites: 0, contextDrops: 0, anchorTails: 0, errors: [] }

  if (!ctx || typeof ctx.on !== 'function') return { dispose() {}, live }

  let off = null
  try {
    off = ctx.on('system-prompt/assemble', (assembled, context, next) => {
      // next() 可能同步抛出（下游监听器故障），也可能返回 reject 的 Promise。
      // 两种情况都不能让整条装配链断掉：降级成用入参继续改写。
      const run = (base) => {
        try {
          const before = Array.isArray(base?.contexts) ? base.contexts.length : 0
          const out = rewriteAssembly(base, context, config)
          const after = Array.isArray(out?.contexts) ? out.contexts.length : 0
          if (after < before) live.contextDrops += before - after
          if (out !== base) live.rewrites += 1
          live.anchorTails += 1
          return out
        } catch (err) {
          if (live.errors.length < 8) live.errors.push(String(err?.message || err))
          return base
        }
      }
      const degraded = (err) => {
        if (live.errors.length < 8) live.errors.push(`next: ${err?.message || err}`)
        return run(assembled)
      }
      if (typeof next !== 'function') return run(assembled)
      let downstream
      try {
        downstream = next()
      } catch (err) {
        return degraded(err)
      }
      if (downstream && typeof downstream.then === 'function') {
        return downstream.then(run, degraded)
      }
      return run(downstream)
    }, { global: true, prepend: true })
    live.installed = true
  } catch (err) {
    if (live.errors.length < 8) live.errors.push(`install: ${err?.message || err}`)
  }

  return {
    dispose() {
      try { if (typeof off === 'function') off() } catch { /* 已释放 */ }
    },
    live,
  }
}

export const __internal = { rewriteAssembly, sanitizeSections, DROP_CONTEXT_NAMES, ANCHOR_TEXT, CHILD_ANCHOR_TEXT }
