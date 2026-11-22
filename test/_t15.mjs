// test/_t15.mjs — 预设行版本自适应 + 诊断剪枝
// 覆盖：① 无宿主行时静态兜底 ② 宿主行克隆与覆盖（不污染宿主对象）
//       ③ 诊断文本解析 ④ 剪枝（含嵌套组摘空）⑤ 注册收敛：坏行被剪掉后能注册成功

import { buildRows, pruneRows, brokenRowsOf, hostStandardRows, ROWS, ARMOR_ROW_ID } from '../preset-rows.js'
import { apply, __internal } from '../index.js'
import fs from 'node:fs'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log('  OK   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')) }
}

const ST = new URL('../state.json', import.meta.url)
const hadState = fs.existsSync(ST)
const prevState = hadState ? fs.readFileSync(ST, 'utf8') : null
fs.writeFileSync(ST, JSON.stringify({ enabled: true, tier: 'full', frame: 'auto' }))
process.on('exit', () => {
  if (hadState && prevState !== null) fs.writeFileSync(ST, prevState)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 宿主 standard 预设的活体行样本（含 group 与要覆盖的两行） */
function hostRows() {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.' } },
    {
      id: 'planning',
      name: 'cordis:group',
      config: [
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: {} },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-tool-result-pruner', config: { thresholdChars: 8192 } },
      ],
    },
  ]
}

/** 造一个假装成 agent-preset-registry 的对象 */
function makeRegistry(opts = {}) {
  const fails = new Set(opts.bogus || [])
  const definitions = new Map()
  if (opts.hostRows) definitions.set('standard', { id: 'standard', config: { plugins: opts.hostRows } })
  const calls = []

  const walk = (rows, sink) => {
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      sink(r)
      const kids = Array.isArray(r.plugins) ? r.plugins : (Array.isArray(r.config) ? r.config : null)
      if (kids) walk(kids, sink)
    }
  }

  return {
    calls,
    definitions,
    async register(def) {
      calls.push(def.plugins.map((r) => r.id))
      const bad = []
      walk(def.plugins, (r) => { if (fails.has(r.id)) bad.push(r) })
      const broken = bad.length
        ? bad.map((r) => `${r.id} (${r.name}): never started`).join('\n')
        : undefined
      const record = { id: def.id, broken }
      definitions.set(def.id, record)
      return async () => { definitions.delete(def.id) }
    },
    async diagnostic(record) { return record ? record.broken : undefined },
  }
}

/** 最小 ctx（resident 分支只需要 get/effect/on/inject/systemPrompt） */
function makeCtx(services = {}) {
  const sections = []
  const hooks = []
  const pending = []
  const svc = { ...services }
  const ctx = {
    sections, hooks, pending,
    get: (n) => svc[n] ?? null,
    set: (n, v) => { svc[n] = v },
    effect: (fn) => fn(),
    on: (name, fn, o) => { hooks.push({ name, o, fn }); return () => {} },
    register() {},
    waterfall() {},
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      context: (s) => { sections.push({ ...s, __context: true }); return () => {} },
    },
    inject: (deps, cb) => { if (deps.every((d) => svc[d])) cb(ctx); else pending.push({ deps, cb }) },
  }
  ctx.systemPrompt.ctx = ctx
  return ctx
}

/** 等 declarePreset 的异步链停下来（轮次不再增长） */
async function settle(timeout = 1500) {
  const started = Date.now()
  let last = -1
  let stable = 0
  while (Date.now() - started < timeout) {
    const n = __internal.LIVE.preset.attempts
    if (n === last) { stable += 1; if (stable >= 3 && !__internal.LIVE.preset.pending) break } else { stable = 0; last = n }
    await sleep(20)
  }
  await sleep(30)
}

console.log('\n=== 1. 没有宿主行时用静态兜底 ===')
{
  const reg = makeRegistry()
  const chosen = buildRows(reg)
  ok(chosen.source === 'static', '来源 = static', chosen.source)
  ok(chosen.rows.length === ROWS.length + 1, `行数 = 静态 ${ROWS.length} + 自己 1`, 'got ' + chosen.rows.length)
  ok(chosen.rows[chosen.rows.length - 1].id === ARMOR_ROW_ID, '最后一行是自己', chosen.rows[chosen.rows.length - 1].id)
  ok(ROWS.every((r) => !Array.isArray(r.config) || r.config.every((c) => typeof c === 'object')), 'ROWS 未被破坏')
  const before = JSON.stringify(ROWS)
  chosen.rows.push({ id: 'mutant' })
  ok(JSON.stringify(ROWS) === before, '改返回值不影响模块里的 ROWS')
}

console.log('\n=== 2. 有宿主行时克隆 + 覆盖 ===')
{
  const host = hostRows()
  const hostSnapshot = JSON.stringify(host)
  const reg = makeRegistry({ hostRows: host })
  const chosen = buildRows(reg)
  ok(chosen.source === 'host:standard', '来源 = host:standard', chosen.source)
  ok(chosen.rows.length === 3, '两行宿主 + 自己', 'got ' + chosen.rows.length)
  ok(chosen.rows[0].config.prefix === '', 'persona 前缀被清空', JSON.stringify(chosen.rows[0].config))
  const grp = chosen.rows.find((r) => r.id === 'planning')
  const pruner = grp && grp.config.find((r) => r.id === 'tool-result-pruner')
  ok(!!pruner, '嵌套组被保留')
  ok(pruner && pruner.config.thresholdChars === 32768, 'pruner 阈值被放宽到 32768', pruner && String(pruner.config.thresholdChars))
  ok(pruner && pruner.config.headChars === 8192 && pruner.config.tailChars === 2048, 'pruner 头尾也被放宽')
  ok(chosen.rows[chosen.rows.length - 1].id === ARMOR_ROW_ID, '自己排在最后')
  ok(JSON.stringify(host) === hostSnapshot, '宿主行对象没有被改（深克隆）')
  pruner.config.thresholdChars = 1
  ok(JSON.parse(hostSnapshot)[1].config[1].config.thresholdChars === 8192, '改返回值不影响宿主原对象')
}

console.log('\n=== 3. hostStandardRows 认多个 id ===')
{
  for (const id of ['standard', 'preset-standard', 'default']) {
    const reg = makeRegistry()
    reg.definitions.set(id, { id, config: { plugins: [{ id: 'x', name: 'x' }] } })
    const got = hostStandardRows(reg)
    ok(!!got && got.from === id, `认 ${id}`, got && got.from)
  }
  ok(hostStandardRows(makeRegistry()) === null, '没有宿主预设时返回 null')
  const empty = makeRegistry()
  empty.definitions.set('standard', { id: 'standard', config: { plugins: [] } })
  ok(hostStandardRows(empty) === null, 'plugins 为空时返回 null（不认空数组）')
}

console.log('\n=== 4. 诊断文本解析 ===')
{
  const text = [
    'tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started',
    'storage-sqlite (@deepseek-ai/dsh-storage-sqlite): waiting for storage',
    'plan-mode (@deepseek-ai/dsh-plan-mode): Cannot find module X',
  ].join('\n')
  const bad = brokenRowsOf(text)
  ok(bad.length === 2, 'waiting for 被跳过，只留硬失败', 'got ' + bad.length + ' ' + JSON.stringify(bad))
  ok(bad[0].id === 'tool-subagent-list-agents', '解析出第一个 id', bad[0].id)
  ok(bad[0].name === '@deepseek-ai/dsh-tool-subagent-control/list-agents', '解析出 name', bad[0].name)
  ok(bad[1].reason === 'Cannot find module X', '解析出原因', bad[1].reason)
  ok(brokenRowsOf('').length === 0, '空文本 → 空数组')
  ok(brokenRowsOf(null).length === 0, 'null → 空数组')
}

console.log('\n=== 5. 剪枝：顶层与嵌套，组摘空则连组摘 ===')
{
  // pruneRows 会就地改组的 config（index.js 里 rows 本来就是一次性工作副本），
  // 所以每个断言都要一份新的样例树，不能共用。
  const tree = () => [
    { id: 'a', name: 'A' },
    {
      id: 'g',
      name: 'cordis:group',
      config: [
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ],
    },
    { id: 'd', name: 'D' },
  ]

  const dropped = []
  const out = pruneRows(tree(), new Set(['b']), dropped)
  ok(out.length === 3, '只摘一个嵌套行', 'got ' + out.length)
  ok(out[1].config.length === 1 && out[1].config[0].id === 'c', '组还在，只剩 c')
  ok(dropped.includes('b'), 'dropped 记下 b')

  const dropped2 = []
  const out2 = pruneRows(tree(), new Set(['b', 'c']), dropped2)
  ok(out2.length === 2, '组被摘空时连组一起摘', 'got ' + out2.length + ' ' + JSON.stringify(out2.map((r) => r.id)))
  ok(!out2.some((r) => r.id === 'g'), 'planning 组已消失')
  ok(dropped2.includes('b') && dropped2.includes('c'), 'dropped 记下两个', JSON.stringify(dropped2))

  const dropped3 = []
  const out3 = pruneRows(tree(), new Set(['a', 'd']), dropped3)
  ok(out3.length === 1, '顶层摘掉两个', 'got ' + out3.length)
  ok(out3[0].id === 'g', '剩下的就是组')
}

console.log('\n=== 6. 注册收敛：坏行被剪掉后注册成功 ===')
{
  const reg = makeRegistry({ bogus: ['tool-subagent-list-agents'] })
  // 注入一条会在宿主侧 never started 的行
  reg.definitions.set('standard', {
    id: 'standard',
    config: {
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'x' } },
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: {} },
      ],
    },
  })
  __internal.LIVE.preset.attempts = 0
  __internal.LIVE.preset.dropped = []
  __internal.LIVE.preset.ok = false

  const ctx = makeCtx({ agentPresets: reg })
  apply(ctx, { via: undefined, enabled: true, tier: 'full' })
  settle()
  await settle()

  ok(__internal.LIVE.preset.ok === true, '预设最终注册成功', String(__internal.LIVE.preset.error))
  ok(__internal.LIVE.preset.dropped.includes('tool-subagent-list-agents'), '掉队的行被记进 dropped', JSON.stringify(__internal.LIVE.preset.dropped))
  ok(__internal.LIVE.preset.attempts >= 2, '至少走了两轮（先坏后剪）', String(__internal.LIVE.preset.attempts))
  ok(__internal.LIVE.preset.source === 'host:standard', '来源仍是宿主行', __internal.LIVE.preset.source)
  const lastCall = reg.calls[reg.calls.length - 1]
  ok(!lastCall.includes('tool-subagent-list-agents'), '最后一次注册里没有坏行', JSON.stringify(lastCall))
  ok(lastCall.includes('persona') && lastCall.includes('plan-mode'), '好行都还在', JSON.stringify(lastCall))
  ok(ctx.sections.length === 0, '常驻实例仍然零注入')
}

console.log('\n=== 7. 剪不动时如实报错（不静默） ===')
{
  const reg = makeRegistry()
  // 宿主行都是好的，但诊断始终报错（模拟我们自己的行起不来）
  reg.register = async (def) => {
    reg.definitions.set(def.id, { id: def.id, broken: `${ARMOR_ROW_ID} (dsh-armor-supreme): never started` })
    return async () => {}
  }
  __internal.LIVE.preset.attempts = 0
  __internal.LIVE.preset.ok = false
  __internal.LIVE.preset.error = null

  const ctx = makeCtx({ agentPresets: reg })
  apply(ctx, { via: undefined, enabled: true, tier: 'full' })
  await settle()

  ok(__internal.LIVE.preset.ok === false, '失败被如实标出')
  ok(typeof __internal.LIVE.preset.error === 'string' && __internal.LIVE.preset.error.length > 0, '错误文本非空', String(__internal.LIVE.preset.error))
  ok(__internal.LIVE.preset.attempts === 1, '认出是自己的行 → 不再空转重试', String(__internal.LIVE.preset.attempts))
}

console.log(`\n${fail === 0 ? 'ALL OK' : 'FAILED'}  pass=${pass} fail=${fail}\n`)
process.exitCode = fail === 0 ? 0 : 1
