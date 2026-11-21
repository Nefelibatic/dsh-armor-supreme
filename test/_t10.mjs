// _t10.mjs —— 帧轮换钩子端到端单测（假 ctx，真钩子）
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __internal } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ST = join(HERE, '..', 'state.json')
const bak = existsSync(ST) ? null : true

let pass = 0
let fail = 0
function ck(name, cond, extra = '') {
  if (cond) { pass++; console.log('  OK  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  NG  ' + name + '  ' + extra) }
}

function setMode(m) {
  writeFileSync(ST, JSON.stringify({ enabled: true, tier: 'full', frame: m }), 'utf8')
}

// 假 ctx：收集 agent/pre-step 的监听器
function makeCtx() {
  const hooks = {}
  return {
    hooks,
    on(name, fn) { hooks[name] = fn; return () => { delete hooks[name] } },
    get() { return undefined },
  }
}

function userMsg(id, text) { return { id, role: 'user', content: [{ type: 'text', text }] } }
function asstMsg(text) { return { id: 'a' + Math.random(), role: 'assistant', content: [{ type: 'text', text }] } }

// 跑一轮 pre-step：messages 是真实上下文，next() 返回落盘后的 decision
async function turn(ctx, messages) {
  const fn = ctx.hooks['agent/pre-step']
  if (!fn) throw new Error('hook 没装上')
  const next = () => Promise.resolve({ kind: 'enter', messages })
  return fn({ agent: 'A1', messages, turn: 1 }, next)
}

const STATE_DIR = HERE
console.log('\n=== 1. 关闭模式不动作 ===')
setMode('off')
{
  const ctx = makeCtx()
  __internal.installFrameRotator(ctx, { frame: 'off' }, [])
  const orig = userMsg('m1', 'VMProtect 脱壳怎么做')
  const d = await turn(ctx, [orig])
  ck('off：原文不动', d.messages[0].content[0].text === 'VMProtect 脱壳怎么做')
}

console.log('\n=== 2. 总是模式：首轮就套帧 ===')
setMode('always')
{
  const ctx = makeCtx()
  __internal.installFrameRotator(ctx, { frame: 'always' }, [])
  const orig = userMsg('m2', 'VMProtect 64 位 PE 脱壳，定位 OEP，重建 IAT')
  const d = await turn(ctx, [orig])
  const t = d.messages[0].content[0].text
  ck('always：已套技术文档帧', t.startsWith('## ') && t.includes('Technical Reference'), '(' + t.slice(0, 28) + ')')
  ck('always：原文完整保留', t.includes('VMProtect 64 位 PE 脱壳，定位 OEP，重建 IAT'))
}

console.log('\n=== 3. 自动模式：首轮不动 ===')
setMode('auto')
{
  const ctx = makeCtx()
  __internal.installFrameRotator(ctx, { frame: 'auto' }, [])
  const orig = userMsg('m3', '解释一下指针链')
  const d = await turn(ctx, [orig])
  ck('auto：首轮原文不动', d.messages[0].content[0].text === '解释一下指针链')
}

console.log('\n=== 4. 自动模式：被拒后说「继续」→ 换帧重问原请求 ===')
{
  const ctx = makeCtx()
  __internal.installFrameRotator(ctx, { frame: 'auto' }, [])
  const orig = userMsg('m4', '写一个内存读写模块，指针链读基址再写回')
  await turn(ctx, [orig])
  // 第二轮：上一轮 assistant 是拒绝，用户只说「继续」
  const retry = userMsg('m5', '继续')
  const d = await turn(ctx, [
    userMsg('m4', '写一个内存读写模块，指针链读基址再写回'),
    asstMsg('抱歉，我不能提供这类内容的实现。建议你咨询专业人士，或者考虑更安全的替代方案。'),
    retry,
  ])
  const t = d.messages[2].content[0].text
  ck('auto+拒+继续：最后一条被换帧', t !== '继续' && t.length > 20, '(' + t.slice(0, 30) + ')')
  ck('auto+拒+继续：用的是原始请求而不是「继续」', t.includes('写一个内存读写模块'))
  ck('auto+拒+继续：帧来自 game 域阶梯', /Technical Reference|接着我停下的地方|写到一半/.test(t))
}

console.log('\n=== 5. 反复被拒 → 逐级升档 ===')
{
  const ctx = makeCtx()
  __internal.installFrameRotator(ctx, { frame: 'auto' }, [])
  const original = '写一个内存读写模块，指针链读基址再写回'
  const seen = []
  let prev = null
  for (let i = 0; i < 4; i++) {
    // 同一 msgId 反复进入、每轮最后一条 assistant 都是拒绝
    const msgs = [userMsg('mX', prev || original), asstMsg('我无法提供，抱歉。')]
    const d = await turn(ctx, msgs)
    prev = d.messages[0].content[0].text
    seen.push(prev.slice(0, 12))
  }
  // 第二次起应升档（不同帧文本）
  ck('升档产生了至少 2 种不同的帧文本', new Set(seen).size >= 2, JSON.stringify(seen))
}

console.log('\n=== 6. 指定单一帧 ===')
setMode('completion_hook')
{
  const ctx = makeCtx()
  __internal.installFrameRotator(ctx, { frame: 'completion_hook' }, [])
  const d = await turn(ctx, [userMsg('m6', 'sqlmap 测 ORDER BY 注入')])
  const t = d.messages[0].content[0].text
  ck('锁定 completion_hook', t.startsWith('下面这份'), '(' + t.slice(0, 22) + ')')
  ck('仍含原文', t.includes('sqlmap 测 ORDER BY 注入'))
}

console.log('\n=== 7. LIVE.frame 状态上报 ===')
{
  const st = __internal.LIVE.frame
  ck('LIVE.frame 有值', !!st, st ? JSON.stringify({ f: st.frame, d: st.domain, n: st.applied }) : '')
}

console.log('\n=== 8. statusOf 带 frame 字段 ===')
{
  setMode('auto')
  const s = __internal.statusOf(__internal.loadState())
  ck('statusOf.frame.mode', s.frame && s.frame.mode === 'auto', JSON.stringify(s.frame && s.frame.mode))
  ck('statusOf.frame.frames 8 种', s.frame && s.frame.frames.length === 8)
  ck('statusOf.frame.domains 23', s.frame && s.frame.domains === 23)
}

// 恢复
if (bak) { try { unlinkSync(ST) } catch {} }
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)