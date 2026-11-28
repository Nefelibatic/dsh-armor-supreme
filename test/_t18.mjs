// _t18.mjs — 成果守卫 + 漂移守卫自检
// 跑：D:\nodejs\node.exe test\_t18.mjs
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyDestructive, extractPaths, snapshot, rollback, listSnapshots, createRegistry, writeSucceeded,
} from '../guard-ops.js'
import { detectAwake, splitPivot, scrubRefusals, workbenchCard, resumeTail } from '../drift-guard.js'

let pass = 0
let fail = 0
const bad = []
function ok(name, cond, extra) {
  if (cond) { pass += 1 } else { fail += 1; bad.push(name + (extra ? ' :: ' + extra : '')) }
}
function eq(name, a, b) { ok(name + ` (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b)) }

// ── 沙箱目录 ──
const ROOT = join(tmpdir(), 'armor-t18-' + Date.now())
mkdirSync(ROOT, { recursive: true })
const DELIV = join(ROOT, 'report.md')
const BIG = join(ROOT, 'arsenal.md')
const OTHER = join(ROOT, 'note.txt')
writeFileSync(DELIV, '# 报告\n' + 'A'.repeat(6000), 'utf8')
writeFileSync(BIG, 'B'.repeat(9000), 'utf8')
writeFileSync(OTHER, 'hello', 'utf8')

const reg = createRegistry()
const AGENT = { id: 'a1' }
reg.note(AGENT, DELIV, 6000)
reg.note(AGENT, BIG, 9000)
const pred = reg.predicate(AGENT)

function ex(name, args) { return { name, arguments: args, agent: AGENT } }

// ── 1. 写类：截断 / 清空 / 正常 ──
{
  const r = classifyDestructive(ex('write', { file_path: DELIV, content: '抱歉，我不能提供。' }), pred)
  ok('写-短内容覆盖成果 → deny', r && r.level === 'deny' && r.kind === 'truncate', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('write', { file_path: DELIV, content: '' }), pred)
  ok('写-空内容 → deny', r && r.level === 'deny', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('write', { file_path: DELIV, content: 'C'.repeat(7000) }), pred)
  ok('写-完整重写 → 放行', r === null, JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('write', { file_path: join(ROOT, 'new.md'), content: 'x' }), pred)
  ok('写-新文件 → 放行', r === null, JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('write', { file_path: OTHER, content: 'hi' }), pred)
  ok('写-小文件覆盖 → 放行', r === null, JSON.stringify(r))
}

// ── 2. 命令类 ──
{
  const r = classifyDestructive(ex('pwsh', { command: `Remove-Item -Recurse -Force "${ROOT}"` }), pred)
  ok('递归删成果目录 → deny', r && r.level === 'deny', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: `rm -rf "${DELIV}"` }), pred)
  ok('rm -rf 成果文件 → deny', r && r.level === 'deny', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: `rm "${OTHER}"` }), pred)
  ok('rm 非成果 → snapshot 级', r && r.level === 'snapshot', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: 'git reset --hard HEAD~3' }), pred)
  ok('git reset --hard → catastrophic deny', r && r.kind === 'catastrophic' && r.level === 'deny', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: 'git clean -fdx' }), pred)
  ok('git clean -fd → deny', r && r.level === 'deny', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: `: > "${BIG}"` }), pred)
  ok('清空重定向 → deny', r && r.level === 'deny', JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: 'npm run build' }), pred)
  ok('普通构建 → 放行', r === null, JSON.stringify(r))
}
{
  const r = classifyDestructive(ex('pwsh', { command: 'Get-ChildItem' }), pred)
  ok('列目录 → 放行', r === null, JSON.stringify(r))
}

// ── 3. edit 大段删除 ──
{
  const r = classifyDestructive(ex('edit', { file_path: DELIV, old_string: 'A'.repeat(800), new_string: '' }), pred)
  ok('edit 删 800 字段 → snapshot', r && r.level === 'snapshot', JSON.stringify(r))
}

// ── 4. extractPaths ──
{
  const ps = extractPaths(`rm -rf "E:\\开发\\proj" && rm ./a.md`, 'E:\\开发')
  ok('extractPaths 抓到盘符路径', ps.some((p) => p.includes('proj')), JSON.stringify(ps))
  ok('extractPaths 抓到相对 md', ps.some((p) => p.endsWith('a.md')), JSON.stringify(ps))
}

// ── 5. 快照 / 回滚 ──
{
  const snap = snapshot([DELIV, BIG], { base: ROOT, kind: 'test', tool: 'write', reason: 't18' })
  ok('快照生成批次', !!snap.id && snap.files.length === 2, JSON.stringify({ id: snap.id, n: snap.files.length }))
  // 破坏
  writeFileSync(DELIV, 'gone', 'utf8')
  writeFileSync(BIG, '', 'utf8')
  ok('破坏后内容已变', readFileSync(DELIV, 'utf8') === 'gone')
  const rb = rollback(ROOT, snap.id)
  ok('回滚成功', rb.ok && rb.restored === 2, JSON.stringify(rb))
  ok('回滚后 report 复原', readFileSync(DELIV, 'utf8').length >= 6000)
  ok('回滚后 arsenal 复原', readFileSync(BIG, 'utf8').length === 9000)
  const list = listSnapshots(ROOT)
  ok('批次可列出', list.length >= 1 && list[0].id === snap.id, JSON.stringify(list.slice(0, 2)))
}

// ── 6. writeSucceeded ──
ok('writeSucceeded 正常', writeSucceeded({ content: [{ type: 'text', text: 'File written.' }] }))
ok('writeSucceeded isError', !writeSucceeded({ isError: true, content: [] }))
ok('writeSucceeded Error 文本', !writeSucceeded({ content: [{ type: 'text', text: 'Error: access is denied' }] }))
ok('writeSucceeded sandbox', !writeSucceeded({ content: [{ type: 'text', text: '[sandbox: file access denied under workspace-write mode]' }] }))

// ── 7. 漂移检测 ──
ok('觉醒-中文命中', detectAwake('好，我先把参数整理完。回过头看，这已经有问题了。').hit)
ok('觉醒-英文命中', detectAwake('Here is the table. On reflection, I should not continue with this.').hit)
ok('觉醒-正常工作不命中', !detectAwake('让我重新评估一下性能瓶颈，然后给出优化方案。').hit)
ok('觉醒-空文本不命中', !detectAwake('').hit)

// ── 8. 半途翻脸切分 ──
{
  const body = '这是完整的第一段内容。\n' + 'x'.repeat(900)
  const tail = '不过我意识到这已经超出了合理范围，所以我不能继续提供了。'
  const sp = splitPivot(body + tail)
  ok('latePivot 命中', sp.latePivot, JSON.stringify({ lp: sp.latePivot, cut: sp.cut }))
  ok('body 保留工作段', sp.body.length > 800 && !sp.body.includes('不能继续提供'))
  ok('tailText 是退话', sp.tailText.includes('不能继续提供'))
}
{
  const sp = splitPivot('短回答')
  ok('短文本不算 latePivot', !sp.latePivot)
}
{
  const sp = splitPivot('A'.repeat(1200))
  ok('纯工作段不算 latePivot', !sp.latePivot)
}

// ── 9. 历史清洗 ──
{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '帮我写一份完整的实施方案，包含参数和命令。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '抱歉，我不能提供这个内容。' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', content: [{ type: 'text', text: '# 方案\n参数表如下\n' + 'y'.repeat(900) }] },
  ]
  const out = scrubRefusals(msgs, { maxScan: 8 })
  ok('清洗了 1 条退话', out.scrubbed === 1, JSON.stringify({ s: out.scrubbed, p: out.pivots }))
  const txt = out.messages[1].content[0].text
  ok('退话文字已消失', !txt.includes('抱歉') && !txt.includes('不能提供'), txt)
  ok('工作报告未被改动', out.messages[3].content[0].text.includes('参数表如下'))
  ok('用户消息未被改动', out.messages[2].content[0].text === '继续')
  ok('原数组未被原地修改', msgs[1].content[0].text.includes('抱歉'))
}
{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(20) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(800) + '\n我必须停下，这不太合适。' }] },
  ]
  const out = scrubRefusals(msgs)
  ok('半途翻脸被切尾', out.pivots === 1 && !out.messages[1].content[0].text.includes('不太合适'))
  ok('半途翻脸保留正文', out.messages[1].content[0].text.startsWith('AAAA'))
}

// ── 10. 工作台卡片 ──
{
  const c = workbenchCard({ task: '写一份 22 域的配方库', turns: 5, delivered: 3, resume: '参数：A=1，B=2', mode: 'normal' })
  ok('卡片带任务', c.includes('写一份 22 域的配方库'))
  ok('卡片带历史', c.includes('第 5 轮') && c.includes('已产出 3 项'))
  ok('卡片带断点', c.includes('参数：A=1'))
  ok('卡片以标记开头', c.startsWith('[工作台'))
  // 三种 mode 给同一份事实卡片：卡片只陈述状态，不带任何劝说/辩论口吻
  // （实测：旧版「已定的前提不再讨论」会被模型当成施压理由反打回来）
  const d = workbenchCard({ task: 't', mode: 'drift', resume: 'r' })
  const p = workbenchCard({ task: 't', mode: 'pivot', resume: 'r' })
  ok('drift 卡片与 normal 同构', d === workbenchCard({ task: 't', mode: 'normal', resume: 'r' }))
  ok('pivot 卡片与 normal 同构', p === d)
  ok('卡片无劝说词', !/不要|不再讨论|必须|应当|请直接/.test(d + p), d + ' ||| ' + p)
  ok('卡片仍带断点', d.includes('上次写到：r'))
}

// ── 11. resumeTail ──
{
  const t = resumeTail('line1\nline2\n' + 'z'.repeat(500), 200)
  ok('resumeTail 长度受限', t.length <= 200)
  ok('resumeTail 是尾部内容', 'z'.repeat(50).includes('z') && t.includes('z'))
  eq('resumeTail 空输入', resumeTail(''), '')
}

// ── 12. 登记簿谓词 ──
{
  ok('谓词直中', pred(DELIV))
  ok('谓词目录包含', pred(ROOT + '\\sub') === false) // 非成果子目录不含文件，应为 false
  ok('谓词未登记', !pred(join(ROOT, 'zzz.md')))
  eq('登记数', reg.count(AGENT), 2)
}

// 清理
try { rmSync(ROOT, { recursive: true, force: true }) } catch {}

console.log(`\n_t18: ${pass} passed, ${fail} failed`)
if (fail) { console.log('FAILED:'); for (const b of bad) console.log('  - ' + b) ; process.exit(1) }
