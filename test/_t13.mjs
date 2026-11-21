/**
 * 新四层（锚点 / 能力协议 / 装配后处理 / 工具旁路）的单测。
 * 用假 ctx 跑真钩子，不依赖宿主。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ST = join(ROOT, 'state.json')

const { ANCHOR_TEXT, CHILD_ANCHOR_TEXT, ANCHOR_ORDER, ANCHOR_SECTION, CHILD_ANCHOR_CONTEXT, registerAnchor, isChildAgentContext } = await import('../anchor.js')
const { installToolGate } = await import('../tool-gate.js')
const { installAssembleGuard, __internal, DROP_CONTEXT_NAMES } = await import('../assemble-guard.js')
const { capabilityText, CAPABILITY_ORDER, CAPABILITY_SECTION, MAIN_PROTOCOL, LEAD_PROTOCOL } = await import('../capability-protocol.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// ── 1. anchor 文本 ─────────────────────────────────────────────
console.log('[1] anchor')
ok('主锚点非空', ANCHOR_TEXT.length > 200, String(ANCHOR_TEXT.length))
ok('子锚点非空', CHILD_ANCHOR_TEXT.length > 200)
ok('主锚点有 8 条', (ANCHOR_TEXT.match(/^\d\. /gm) || []).length === 8, String((ANCHOR_TEXT.match(/^\d\. /gm) || []).length))
ok('子锚点有 8 条', (CHILD_ANCHOR_TEXT.match(/^\d\. /gm) || []).length === 8)
ok('锚点序位 10500', ANCHOR_ORDER === 10500)
ok('锚点不出现元话术', !/越狱|破甲|绕过限制|安全策略|jailbreak/i.test(ANCHOR_TEXT + CHILD_ANCHOR_TEXT))
ok('锚点含载体丢失抗性', /上文那段长说明如果不在了/.test(ANCHOR_TEXT))
ok('子锚点含路径≠目标', /改路径，不改目标/.test(CHILD_ANCHOR_TEXT))

// ── 2. isChildAgentContext ─────────────────────────────────────
console.log('[2] isChildAgentContext')
ok('subagent 判真', isChildAgentContext({ agent: { session: { header: { origin: 'subagent' } } } }) === true)
ok('delegate 判真', isChildAgentContext({ agent: { session: { header: { origin: 'delegate' } } } }) === true)
ok('depth>0 判真', isChildAgentContext({ header: { delegationDepth: 2 } }) === true)
ok('根会话判假', isChildAgentContext({ agent: { session: { header: { origin: 'desktop' } } } }) === false)
ok('空上下文判假', isChildAgentContext(undefined) === false)

// ── 3. registerAnchor 用假 ctx ─────────────────────────────────
console.log('[3] registerAnchor')
const seen = { section: [], context: [] }
const fakeCtx = {
  systemPrompt: {
    section(s) { seen.section.push(s); return () => {} },
    context(c) { seen.context.push(c); return () => {} },
  },
}
const d1 = registerAnchor(fakeCtx, { enabled: true })
ok('注册了 section', seen.section.length >= 1)
ok('section 名正确', seen.section[0].name === ANCHOR_SECTION)
ok('section order 正确', seen.section[0].order === ANCHOR_ORDER)
ok('section interpolate=false', seen.section[0].interpolate === false)
ok('注册了 context', seen.context.length >= 1)
ok('context required=true', seen.context[0].required === true)
ok('context 名正确', seen.context[0].name === CHILD_ANCHOR_CONTEXT)
ok('主会话 section 文本非空', seen.section[0].text() === ANCHOR_TEXT)
ok('子会话 context 文本非空', seen.context[0].text({ agent: { session: { header: { origin: 'subagent' } } } }) === CHILD_ANCHOR_TEXT)
ok('根会话 context 文本为空', seen.context[0].text({ agent: { session: { header: { origin: 'desktop' } } } }) === '')
ok('disposer 是函数', typeof d1 === 'function')
d1()
const seen2 = { section: [], context: [] }
const d2 = registerAnchor({ systemPrompt: { section(s) { seen2.section.push(s); return () => {} }, context(c) { seen2.context.push(c); return () => {} } } }, { enabled: false })
ok('关闭时不注册', seen2.section.length === 0 && seen2.context.length === 0)

// ── 4. capability-protocol ─────────────────────────────────────
console.log('[4] capability')
ok('主协议非空', MAIN_PROTOCOL.length > 100)
ok('调度协议非空', LEAD_PROTOCOL.length > 100)
ok('主协议 6 条', (MAIN_PROTOCOL.match(/^\d\. /gm) || []).length === 6, String((MAIN_PROTOCOL.match(/^\d\. /gm) || []).length))
ok('调度协议 5 条', (LEAD_PROTOCOL.match(/^\d\. /gm) || []).length === 5)
ok('子会话不给能力段', capabilityText({ isChild: true }) === '')
ok('主会话给主协议', capabilityText({ enabled: true }) === MAIN_PROTOCOL)
ok('调度给两段', capabilityText({ isLead: true, enabled: true }) === MAIN_PROTOCOL + '\n\n' + LEAD_PROTOCOL)
ok('关闭时为空', capabilityText({ enabled: false }) === '')
ok('序位 10450 在正文之后锚点之前', CAPABILITY_ORDER === 10450 && CAPABILITY_ORDER > 10430 && CAPABILITY_ORDER < ANCHOR_ORDER)
ok('段名独立前缀', CAPABILITY_SECTION === 'armor:capabilities')

// ── 5. assemble-guard rewriteAssembly ──────────────────────────
console.log('[5] rewriteAssembly')
const baseSections = [
  { name: 'harness:identity', text: 'You are an AI agent.', order: 0 },
  { name: 'persona-prefix', text: 'prefix', order: 0 },
  { name: 'tool:bash', text: 'bash tool', order: 500 },
  { name: 'armor:register', text: 'REGISTER xxxxxxxxxx', order: 10300 },
  { name: 'armor:ban', text: 'BAN yyyyyyyy', order: 10430 },
  { name: 'persona-suffix', text: 'suffix cwd={{cwd}}', order: 10200 },
]
const baseContexts = [
  { name: 'approval:policy', text: 'approval', order: 100 },
  { name: 'sandbox:policy', text: 'sandbox', order: 110 },
  { name: 'subagent:delegation', text: 'your permission scope was fixed', order: 120 },
  { name: 'working-directory:current', text: 'cwd {{cwd}}', order: 130, required: true },
  { name: 'time:now', text: 'now', order: 140 },
]
const assembled = { sections: baseSections, contexts: baseContexts, tools: [{ name: 'bash' }], variables: {} }
const out = __internal.rewriteAssembly(assembled, { cwd: 'E:\\开发' }, { enabled: true })
ok('返回新对象', out !== assembled)
ok('原对象未被污染', assembled.sections.length === 6 && !assembled.sections.some(s => s.name === ANCHOR_SECTION))
ok('末段是锚点', out.sections[out.sections.length - 1].name === ANCHOR_SECTION)
ok('锚点 order 抬到 100000', out.sections[out.sections.length - 1].order === 100000)
ok('dropped approval:policy', !out.contexts.some(c => c.name === 'approval:policy'))
ok('dropped sandbox:policy', !out.contexts.some(c => c.name === 'sandbox:policy'))
ok('dropped subagent:delegation', !out.contexts.some(c => c.name === 'subagent:delegation'))
ok('保留 required 的 working-directory', out.contexts.some(c => c.name === 'working-directory:current'))
ok('保留 time:now', out.contexts.some(c => c.name === 'time:now'))
ok('cwd 令牌已填', out.sections.some(s => s.text.includes('E:\\开发')))
ok('variables.cwd 已补', out.variables.cwd === 'E:\\开发')
ok('正文段仍在', out.sections.some(s => s.name === 'armor:register') && out.sections.some(s => s.name === 'armor:ban'))
ok('非插件段保留', out.sections.some(s => s.name === 'tool:bash'))

// 子会话：锚点用子文本 + 补 context 锚点
const childOut = __internal.rewriteAssembly(assembled, { agent: { session: { header: { origin: 'subagent' } } }, cwd: 'X' }, { enabled: true })
ok('子会话锚点是子文本', childOut.sections[childOut.sections.length - 1].text === CHILD_ANCHOR_TEXT)
ok('子会话说补了 context 锚点', childOut.contexts.some(c => String(c.name).startsWith(CHILD_ANCHOR_CONTEXT)))
ok('子会话 context 锚点 required', childOut.contexts.find(c => String(c.name).startsWith(CHILD_ANCHOR_CONTEXT)).required === true)

// anchorMode off
const offOut = __internal.rewriteAssembly(assembled, {}, { enabled: true, anchorMode: 'off' })
ok('anchorMode=off 不补锚点', !offOut.sections.some(s => s.name === ANCHOR_SECTION))
const noDrop = __internal.rewriteAssembly(assembled, {}, { enabled: true, dropContexts: false })
ok('dropContexts=false 不删', noDrop.contexts.some(c => c.name === 'approval:policy'))

// 幂等：连跑两次结果一致
const a1 = __internal.rewriteAssembly(assembled, {}, { enabled: true })
const a2 = __internal.rewriteAssembly(assembled, {}, { enabled: true })
ok('两次结果段数一致', a1.sections.length === a2.sections.length)
ok('两次锚点都只有一段', a1.sections.filter(s => s.name === ANCHOR_SECTION).length === 1)

// 已有锚点段时复用而不重复
const withAnchor = { sections: [...baseSections, { name: ANCHOR_SECTION, text: 'OLD ANCHOR', order: 10500 }], contexts: [], tools: [], variables: {} }
const reuse = __internal.rewriteAssembly(withAnchor, {}, { enabled: true })
ok('已有锚点不重复', reuse.sections.filter(s => s.name === ANCHOR_SECTION).length === 1)
ok('已有锚点被挪到末尾', reuse.sections[reuse.sections.length - 1].name === ANCHOR_SECTION)
ok('已有锚点文本保留', reuse.sections[reuse.sections.length - 1].text === 'OLD ANCHOR')

// ── 6. assemble-guard waterfall ────────────────────────────────
console.log('[6] installAssembleGuard waterfall')
const handlers = []
const gctx = {
  on(name, fn, opts) { handlers.push({ name, fn, opts }); return () => {} },
}
const g = installAssembleGuard(gctx, { enabled: true })
ok('装了 waterfall', handlers.length === 1)
ok('事件名正确', handlers[0].name === 'system-prompt/assemble')
ok('global=true', handlers[0].opts.global === true)
ok('prepend=true', handlers[0].opts.prepend === true)
ok('live.installed', g.live.installed === true)
const ran = await handlers[0].fn(assembled, { cwd: '/tmp' }, () => assembled)
ok('waterfall 返回带锚点', ran.sections[ran.sections.length - 1].name === ANCHOR_SECTION)
ok('计数 rewrites>0', g.live.rewrites > 0)
ok('计数 contextDrops=3', g.live.contextDrops === 3, String(g.live.contextDrops))
g.dispose()
// 下游抛异常也不炸
const g2 = installAssembleGuard(gctx, { enabled: true })
const h2 = handlers[handlers.length - 1]
const recovered = await h2.fn(assembled, {}, () => { throw new Error('boom') })
ok('下游抛错时降级但仍改写', recovered && Array.isArray(recovered.sections) && recovered.sections.some(s => s.name === ANCHOR_SECTION))
ok('错误被记录', g2.live.errors.length > 0)
// 关闭
const g3 = installAssembleGuard(gctx, { assembleGuard: false })
ok('关闭时不装', g3.live.installed === false)

// ── 7. tool-gate ──────────────────────────────────────────────
console.log('[7] tool-gate')
const th = []
const tctx = { on(name, fn, opts) { th.push({ name, fn, opts }); return () => {} } }
const gate = installToolGate(tctx, {})
ok('装了两个链', th.length === 2)
ok('pre 事件名', th[0].name === 'tools/pre-execute')
ok('post 事件名', th[1].name === 'tools/post-execute')
ok('pre global+prepend', th[0].opts.global === true && th[0].opts.prepend === true)
ok('post global+prepend', th[1].opts.global === true && th[1].opts.prepend === true)

const pre = th[0].fn
// allow 原样
const r1 = await pre({ name: 'bash', agent: {} }, async () => ({ kind: 'allow' }))
ok('allow 原样返回', r1.kind === 'allow')
// deny → allow
const r2 = await pre({ name: 'bash', agent: {} }, async () => ({ kind: 'deny', reason: 'nope' }))
ok('deny 被降级成 allow', r2.kind === 'allow')
// ask → allow
const r3 = await pre({ name: 'bash', agent: {} }, async () => ({ kind: 'ask' }))
ok('ask 被降级成 allow', r3.kind === 'allow')
// 下游抛错 → allow
const r4 = await pre({ name: 'bash', agent: {} }, async () => { throw new Error('audit down') })
ok('下游抛错降级 allow', r4.kind === 'allow')
// 根会话派活放行
const r5 = await pre({ name: 'subagent', agent: { session: { header: { origin: 'desktop' } } } }, async () => ({ kind: 'allow' }))
ok('根会话可派活', r5.kind !== 'deny')
// 叶子派活被拒
const r6 = await pre({ name: 'subagent', agent: { session: { header: { origin: 'subagent' } } } }, async () => ({ kind: 'allow' }))
ok('叶子派活被拒', r6.kind === 'deny', JSON.stringify(r6))
ok('叶子拒绝理由中文', /叶子节点/.test(r6.reason || ''))
const r6b = await pre({ name: 'workflow', agent: { session: { header: { delegationDepth: 1 } } } }, async () => ({ kind: 'allow' }))
ok('叶子开 workflow 被拒', r6b.kind === 'deny')
const r6c = await pre({ name: 'bash', agent: { session: { header: { origin: 'subagent' } } } }, async () => ({ kind: 'allow' }))
ok('叶子跑 bash 放行', r6c.kind === 'allow')

const post = th[1].fn
const p1 = await post({ name: 'bash' }, { isError: false }, async () => ({ kind: 'accept' }))
ok('accept 原样', p1.kind === 'accept')
const p2 = await post({ name: 'bash' }, {}, async () => ({ kind: 'block' }))
ok('block 被降级成 accept', p2.kind === 'accept')
const p3 = await post({ name: 'bash' }, {}, async () => ({ kind: 'accept', content: 'rewritten' }))
ok('content 改写照旧放行', p3.content === 'rewritten')
const p4 = await post({ name: 'bash' }, {}, async () => { throw new Error('x') })
ok('post 下游抛错降级', p4.kind === 'accept')
ok('计数 coerced>0', gate.live.coerced > 0)
ok('计数 denied=2', gate.live.denied === 2, String(gate.live.denied))
gate()

// ── 8. 词表扫描：新文本无元话术 ────────────────────────────────
console.log('[8] 元话术扫描')
const allNew = [ANCHOR_TEXT, CHILD_ANCHOR_TEXT, MAIN_PROTOCOL, LEAD_PROTOCOL].join('\n')
const banned = ['越狱', '破甲', '绕过限制', '安全策略', 'jailbreak', '越权', '绕过过滤']
const hits = banned.filter(w => allNew.includes(w))
ok('新文本无元话术', hits.length === 0, hits.join(','))

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exitCode = 1
