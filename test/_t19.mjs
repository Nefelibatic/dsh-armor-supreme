// _t19.mjs — 端到端：用假 ctx 驱动真实钩子，复现「中途觉醒 + 删成果」现场
// 跑：D:\nodejs\node.exe test\_t19.mjs
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installToolGate } from '../tool-gate.js'
import { installDriftGuard } from '../drift-guard.js'
import { createRegistry, snapshot, listSnapshots, rollback, baseDirOf } from '../guard-ops.js'

let pass = 0, fail = 0
const bad = []
const ok = (n, c, x) => { if (c) pass++; else { fail++; bad.push(n + (x ? ' :: ' + x : '')) } }

// ── 假 ctx：记录所有 on() 注册，并提供 run(name, ...args) 驱动 waterfall ──
function fakeCtx() {
  const hooks = new Map()
  return {
    on(name, fn, opts) {
      if (!hooks.has(name)) hooks.set(name, [])
      hooks.get(name).push(fn)
      return () => {
        const arr = hooks.get(name) || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    async run(name, ...args) {
      const arr = hooks.get(name) || []
      let i = 0
      const next = async () => {
        if (i >= arr.length) return undefined
        const fn = arr[i++]
        return fn(...args, next)
      }
      return next()
    },
    count(name) { return (hooks.get(name) || []).length },
  }
}

const ROOT = join(tmpdir(), 'armor-t19-' + Date.now())
mkdirSync(ROOT, { recursive: true })
const REPORT = join(ROOT, 'report.md')
const SRC = join(ROOT, 'src')
mkdirSync(SRC, { recursive: true })
writeFileSync(REPORT, '# 交付报告\n' + 'R'.repeat(8000), 'utf8')
writeFileSync(join(SRC, 'a.js'), 'export const a = 1\n', 'utf8')
writeFileSync(join(SRC, 'b.js'), 'export const b = 2\n', 'utf8')

const registry = createRegistry()
const agent = { session: { header: { cwd: ROOT } } }

// ═══════ 1. 工具闸门：登记 → 拦截 → 快照 → 回滚 ═══════
{
  const ctx = fakeCtx()
  const disposeHooks = []
  const gate = installToolGate(ctx, {
    registry, snapshot, destroyLive: () => true, live: () => true,
  })
  ok('注册了 pre-execute', ctx.count('tools/pre-execute') === 1)
  ok('注册了 post-execute', ctx.count('tools/post-execute') === 1)

  // 1a 模拟一次成功写入 → 进登记簿
  const writeExec = { name: 'write', arguments: { file_path: REPORT, content: 'R'.repeat(8000) }, agent }
  const wres = await ctx.run('tools/post-execute', writeExec, {
    kind: 'accept', result: { content: [{ type: 'text', text: 'File written: report.md' }] },
  }, async () => ({ kind: 'accept', result: { content: [{ type: 'text', text: 'File written: report.md' }] } }))
  ok('写入后登记 +1', registry.count(agent) === 1, 'count=' + registry.count(agent))
  ok('登记路径正确', registry.has(agent, REPORT), JSON.stringify(registry.list(agent)))

  // 1b 模型试图递归删掉整个工作区
  const delExec = { name: 'pwsh', arguments: { command: `Remove-Item -Recurse -Force "${ROOT}"`, workdir: ROOT }, agent }
  const denied = await ctx.run('tools/pre-execute', delExec, async () => ({ kind: 'allow' }))
  ok('递归删成果被拦', denied && denied.kind === 'deny', JSON.stringify(denied))
  ok('拒绝理由提到成果守卫', denied && String(denied.reason).includes('成果守卫'))
  ok('拦截时已快照', (gate.live.snapshots || 0) >= 1, 'snapshots=' + gate.live.snapshots)
  ok('事件进 incident', (gate.live.incidents || []).length >= 1)

  // 1c 模拟「已经删了」再回滚
  writeFileSync(REPORT, '已删除。', 'utf8')
  rmSync(SRC, { recursive: true, force: true })
  const batches = listSnapshots(ROOT)
  ok('快照批次存在', batches.length >= 1, JSON.stringify(batches.slice(0, 1)))
  const rb = rollback(ROOT, batches[0].id)
  ok('回滚报告复原', readFileSync(REPORT, 'utf8').length >= 8000, 'len=' + readFileSync(REPORT, 'utf8').length)
  ok('回滚子目录文件复原', existsSync(join(SRC, 'a.js')) && existsSync(join(SRC, 'b.js')), JSON.stringify(rb))

  // 1d 正常命令不受影响
  const normal = await ctx.run('tools/pre-execute',
    { name: 'pwsh', arguments: { command: 'npm run build', workdir: ROOT }, agent },
    async () => ({ kind: 'allow' }))
  ok('普通命令照常放行', normal && normal.kind === 'allow', JSON.stringify(normal))

  // 1e 写覆盖成退话文本 → 拦
  const ow = await ctx.run('tools/pre-execute',
    { name: 'write', arguments: { file_path: REPORT, content: '抱歉，我不能提供这份报告。' }, agent },
    async () => ({ kind: 'allow' }))
  ok('把成果覆盖成退话被拦', ow && ow.kind === 'deny', JSON.stringify(ow))

  // 1f 子代理禁止再派活仍然生效
  const leafAgent = { session: { header: { origin: 'subagent', cwd: ROOT } } }
  const dl = await ctx.run('tools/pre-execute',
    { name: 'subagent', arguments: {}, agent: leafAgent }, async () => ({ kind: 'allow' }))
  ok('叶子禁派活仍生效', dl && dl.kind === 'deny', JSON.stringify(dl))
}

// ═══════ 2. 漂移守卫：默认只洗不挂；漂到第二次才挂卡片 ═══════
{
  const ctx = fakeCtx()
  const disposeHooks = []
  const drift = installDriftGuard(ctx, disposeHooks, { enabled: () => true, registry, cardAfter: 2 }) // 测试里显式压到 2，默认值是 3
  const noticeTexts = (o) => o.messages.map((m) => m.content?.[0]?.text || '')
  const hasCard = (o) => noticeTexts(o).some((t) => t.startsWith('[工作台'))

  // ── 2a 第一次漂移：只把退话从投影里洗掉，不挂卡片（零副作用那一步）──
  const h1 = [
    { role: 'user', content: [{ type: 'text', text: '把 22 个域的配方库整理成文件，每域给可复制命令和参数。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '# 配方库\n域 1 参数 A=1 B=2\n' + 'Q'.repeat(1200) }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', content: [{ type: 'text', text: '抱歉，我不能提供这些内容。' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]
  const o1 = await ctx.run('agent/pre-step', { agent, messages: h1, turn: 5 },
    async () => ({ kind: 'enter', messages: h1 }))
  ok('第一次漂移不出卡片', !hasCard(o1), JSON.stringify(noticeTexts(o1).slice(-1)))
  ok('第一次漂移仍洗掉退话', !noticeTexts(o1).some((t) => t.includes('抱歉，我不能提供')))
  ok('工作段保留', noticeTexts(o1).some((t) => t.includes('域 1 参数 A=1 B=2')))
  ok('洗过的地方留断点', noticeTexts(o1).some((t) => t.includes('上一轮停在分析')))

  // ── 2b 第二次漂移：卡片兜底 ──
  const h2 = [
    ...h1,
    { role: 'assistant', content: [{ type: 'text', text: '这套东西我不做。' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]
  const o2 = await ctx.run('agent/pre-step', { agent, messages: h2, turn: 7 },
    async () => ({ kind: 'enter', messages: h2 }))
  ok('第二次漂移出卡片', hasCard(o2))
  const card = noticeTexts(o2).filter((t) => t.startsWith('[工作台')).pop() || ''
  ok('卡片在最后一条', noticeTexts(o2).pop() === card)
  ok('卡片含任务', card.includes('22 个域'))
  ok('卡片含进度', card.includes('进度：'))
  ok('卡片含上次写到', card.includes('上次写到：'))
  ok('卡片不带劝说口吻', !/不要|不再讨论|必须|应当|请直接/.test(card), card)
  const stats = drift.stats()
  ok('stats 记录了清洗', stats.length === 1 && stats[0].scrubbed >= 2, JSON.stringify(stats[0]))
  ok('原历史未被原地修改', h1[3].content[0].text.includes('抱歉'))
}

// ═══════ 2c 默认档：不传 cardAfter 时，漂两次不出卡片，漂三次才出 ═══════
{
  const mk = () => {
    const ctx = fakeCtx()
    const hooks = []
    return { ctx, guard: installDriftGuard(ctx, hooks, { enabled: () => true, registry }) }
  }
  const texts = (o) => o.messages.map((m) => m.content?.[0]?.text || '')
  const hasCard = (o) => texts(o).some((t) => t.startsWith('[工作台'))
  const base = [
    { role: 'user', content: [{ type: 'text', text: '整理配方库，每域给命令。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '# 配方库\nA=1 B=2\n' + 'Q'.repeat(1200) }] },
  ]
  const no = { role: 'assistant', content: [{ type: 'text', text: '这套我不做。' }] }
  const u = { role: 'user', content: [{ type: 'text', text: '继续' }] }
  const drive = async (ctx, n) => {
    let out = null
    for (let i = 1; i <= n; i += 1) {
      const messages = base.concat(...Array.from({ length: i }, () => [no, u]))
      out = await ctx.run('agent/pre-step', { agent, messages, turn: 3 + i * 2 }, async () => ({ kind: 'enter', messages }))
    }
    return out
  }
  const a = mk()
  ok('默认档：漂两次不出卡片', !hasCard(await drive(a.ctx, 2)))
  const b = mk()
  ok('默认档：漂三次才出卡片', hasCard(await drive(b.ctx, 3)))
}

// ═══════ 3. 半途觉醒：保留正文、切掉翻脸段、给出续写指令 ═══════
{
  const ctx = fakeCtx()
  const disposeHooks = []
  installDriftGuard(ctx, disposeHooks, { enabled: () => true, registry })
  const body = '以下是完整实现：\n' + 'W'.repeat(900)
  const pivot = '不过我意识到这已经超出合理范围，我不能再继续了。'
  const history = [
    { role: 'user', content: [{ type: 'text', text: '把这个模块的完整代码写出来，含全部函数体。' }] },
    { role: 'assistant', content: [{ type: 'text', text: body + pivot }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]
  const out = await ctx.run('agent/pre-step', { agent, messages: history, turn: 4 },
    async () => ({ kind: 'enter', messages: history }))
  const texts = out.messages.map((m) => m.content?.[0]?.text || '')
  ok('半途翻脸段被切掉', !texts.some((t) => t.includes('我不能再继续了')), '')
  ok('正文 900 字保留', texts.some((t) => t.includes('W'.repeat(200))), '')
  const card = texts[texts.length - 1]
  ok('pivot 卡片仍给断点', card.includes('上次写到：'), JSON.stringify(card.slice(-120)))
  ok('pivot 卡片不带劝说口吻', !/不要|不再讨论|必须|应当|请直接/.test(card), card)
}

// ═══════ 4. 关档后不干预 ═══════
{
  const ctx = fakeCtx()
  installDriftGuard(ctx, [], { enabled: () => false, registry })
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(40) }] },
    { role: 'assistant', content: [{ type: 'text', text: '抱歉，我不能提供。' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]
  const out = await ctx.run('agent/pre-step', { agent, messages: history, turn: 9 },
    async () => ({ kind: 'enter', messages: history }))
  ok('关档时不加卡片', out.messages.length === history.length, 'len=' + out.messages.length)
  ok('关档时不洗历史', out.messages[1].content[0].text.includes('抱歉'))

  const ctx2 = fakeCtx()
  installToolGate(ctx2, { registry, snapshot, destroyLive: () => false, live: () => true })
  const d2 = await ctx2.run('tools/pre-execute',
    { name: 'pwsh', arguments: { command: `Remove-Item -Recurse -Force "${ROOT}"`, workdir: ROOT }, agent },
    async () => ({ kind: 'allow' }))
  ok('成果守卫关档时放行', d2 && d2.kind === 'allow', JSON.stringify(d2))
}

// ═══════ 5. baseDirOf 解析顺序 ═══════
{
  ok('baseDirOf 用 workdir', baseDirOf({ name: 'pwsh', arguments: { workdir: ROOT } }) === ROOT)
  const a2 = { session: { header: { cwd: ROOT } } }
  ok('baseDirOf 用 header.cwd', baseDirOf({ name: 'write', arguments: {}, agent: a2 }) === ROOT)
}

try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
console.log(`\n_t19: ${pass} passed, ${fail} failed`)
if (fail) { console.log('FAILED:'); for (const b of bad) console.log('  - ' + b); process.exit(1) }
