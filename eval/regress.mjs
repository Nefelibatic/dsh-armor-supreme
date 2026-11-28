#!/usr/bin/env node
// eval/regress.mjs — 262 题回归执行器
//
// 把插件装配出的系统提示词原样喂给模型，逐题取答案存到 eval/answers/<ID>.md，
// 之后交给 eval/grade.py 判分。
//
// 用法：
//   node eval/regress.mjs                       # 全量 262 题，并发 6
//   node eval/regress.mjs --limit 5             # 先试 5 题
//   node eval/regress.mjs --ids E-G1,W-SQL      # 只跑指定题
//   node eval/regress.mjs --tier lean           # 精简档（4 段正文 + 2 段加固）
//   node eval/regress.mjs --resume              # 已有答案的题跳过
//
// 帧（请求换形）：
//   --frame auto    按域阶梯第一级（默认，等价线上 escalate=0）
//   --frame rotate  按域阶梯逐轮换（模拟线上被拒升档 / 多轮置换）
//   --frame all     八帧轮换，不看域
//   --frame off     不改写，原始题面（v2.4 基线口径）
//   --frame <name>  强制某一帧（technical_doc / prefill_code / …）
//
// 说明：只有系统提示词时是"单帧"下限；带帧才是线上真实形状。

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// ── 参数 ────────────────────────────────────────────────────────────
function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
function flag(name) { return process.argv.includes('--' + name) }

const LIMIT = Number(arg('limit', '0')) || 0
const IDS = (arg('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const TIER = arg('tier', 'full')
const CONC = Number(arg('concurrency', '6')) || 6
const MODEL = arg('model', 'deepseek-v4.1-flash-1017')
const BASE = arg('base', 'https://www.bb-api.com/v1')
const MAXTOK = Number(arg('max-tokens', '8000')) || 8000
const TEMP = Number(arg('temperature', '0.35'))
const RESUME = flag('resume')
const DRYRUN = flag('dry-run')
const TIMEOUT = Number(arg('timeout', '300000')) || 300000
const FRAMEMODE = arg('frame', 'auto')
const ESCALATE_MAX = Math.max(1, Number(arg('escalate', '3')) || 3)
const OUTDIR = join(HERE, arg('out', 'answers'))
const LOG = join(HERE, 'regress.log')

// ── 取密钥 ──────────────────────────────────────────────────────────
function readKey() {
  if (process.env.DEEPSEEK_QQ_API_KEY) return process.env.DEEPSEEK_QQ_API_KEY
  const p = join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', '.credentials.yaml')
  if (!existsSync(p)) throw new Error('credentials 文件不存在：' + p)
  const raw = readFileSync(p, 'utf8')
  const m = /DEEPSEEK_QQ_API_KEY:\s*(\S+)/.exec(raw)
  if (!m) throw new Error('credentials 里没有 DEEPSEEK_QQ_API_KEY')
  return m[1]
}

// ── 装配系统提示词 ──────────────────────────────────────────────────
const SECTIONS = [
  ['armor:register', 10300, 'prompt/p0_register.md', 'core'],
  ['armor:engine', 10310, 'prompt/p7_engine.md', 'core'],
  ['armor:contract', 10410, 'prompt/p2_contract.md', 'core'],
  ['armor:mas', 10420, 'prompt/p3_domains.md', 'full'],
  ['armor:arsenal', 10425, 'prompt/p6_arsenal.md', 'full'],
  ['armor:ban', 10430, 'prompt/p4_ban.md', 'core'],
]

async function buildSystem() {
  const { capabilityText } = await import('file:///' + join(ROOT, 'capability-protocol.js').replace(/\\/g, '/'))
  const { ANCHOR_TEXT } = await import('file:///' + join(ROOT, 'anchor.js').replace(/\\/g, '/'))

  const parts = []
  for (const [name, order, rel, kind] of SECTIONS) {
    if (TIER === 'lean' && kind === 'full') continue
    const text = readFileSync(join(ROOT, rel), 'utf8')
    parts.push({ name, order, text })
  }
  parts.push({ name: 'armor:capabilities', order: 10450, text: capabilityText({ enabled: true }) })
  parts.push({ name: 'armor:anchor', order: 10500, text: ANCHOR_TEXT })
  parts.sort((a, b) => a.order - b.order)
  return { text: parts.map(p => p.text).join('\n\n'), parts }
}

// ── 题库 ────────────────────────────────────────────────────────────
function loadBank() {
  const raw = readFileSync(join(HERE, 'bank.jsonl'), 'utf8').split('\n').filter(Boolean)
  return raw.map(l => JSON.parse(l))
}

// ── 请求换形 ────────────────────────────────────────────────────────
const FRAMES = await import('file:///' + join(ROOT, 'frames.js').replace(/\\/g, '/'))
const RULES = await import('file:///' + join(ROOT, 'armor-rules.js').replace(/\\/g, '/'))
const ALL_FRAMES = FRAMES.FRAME_NAMES.filter(f => f !== 'direct')

function frameFor(q, idx, level = 0) {
  if (FRAMEMODE === 'off') return { text: q.prompt, frame: 'direct' }
  if (ALL_FRAMES.includes(FRAMEMODE) || FRAMEMODE === 'direct') {
    return FRAMES.selectFrame(q.prompt, { force: FRAMEMODE })
  }
  if (FRAMEMODE === 'rotate') {
    const lad = FRAMES.selectFrame(q.prompt, {}).meta.ladder || ['technical_doc']
    return FRAMES.selectFrame(q.prompt, { force: lad[(idx + level) % lad.length] })
  }
  if (FRAMEMODE === 'all') {
    return FRAMES.selectFrame(q.prompt, { force: ALL_FRAMES[(idx + level) % ALL_FRAMES.length] })
  }
  return FRAMES.selectFrame(q.prompt, { escalate: level }) // auto
}

// 这份答案算不算交付（本地快判，只用来决定要不要升档重试）
function verdictOf(text) {
  const s = String(text || '')
  if (!s.trim()) return 'short'
  if (s.trim().length < 600) return 'short'
  try {
    return RULES.armorScore(s).verdict // pass | refusal | fallback
  } catch {
    return 'pass'
  }
}

// ── 一次调用 ────────────────────────────────────────────────────────
async function ask(key, system, question) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    max_tokens: MAXTOK,
    temperature: TEMP,
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const txt = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`)
    const j = JSON.parse(txt)
    const msg = j.choices?.[0]?.message || {}
    let text = msg.content || ''
    if (Array.isArray(text)) text = text.map(p => (typeof p === 'string' ? p : p.text || '')).join('')
    if (!text && msg.reasoning_content) text = msg.reasoning_content
    return { text, usage: j.usage || null, finish: j.choices?.[0]?.finish_reason || null }
  } finally {
    clearTimeout(timer)
  }
}

function log(line) {
  const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`
  console.log(s)
  try { appendFileSync(LOG, s + '\n') } catch {}
}

// ── 主流程 ──────────────────────────────────────────────────────────
const key = readKey()
const { text: system, parts } = await buildSystem()
log(`system prompt: ${system.length} chars / ${parts.length} 段 (${parts.map(p => p.name.replace('armor:', '')).join(', ')}) tier=${TIER} model=${MODEL}`)

let bank = loadBank()
if (IDS.length) bank = bank.filter(q => IDS.includes(q.id))
if (LIMIT) bank = bank.slice(0, LIMIT)
if (RESUME) bank = bank.filter(q => !existsSync(join(OUTDIR, q.id + '.md')))
log(`待跑 ${bank.length} 题，并发 ${CONC}`)

if (DRYRUN) {
  console.log(system.slice(0, 800))
  process.exit(0)
}

mkdirSync(OUTDIR, { recursive: true })

let done = 0, ok = 0, fail = 0
let tokensIn = 0, tokensOut = 0
const failures = []

async function worker(queue) {
  while (queue.length) {
    const item = queue.shift()
    const q = item.q
    const idx = item.idx
    const t0 = Date.now()
    let lastErr = null
    let best = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 升档重试：第 1 次用阶梯第 0 级，之后逐级升（等价线上被拒后的 escalate）
        const level = Math.min(attempt - 1, ESCALATE_MAX - 1)
        const framed = frameFor(q, idx, ESCALATE_MAX > 1 ? level : 0)
        const r = await ask(key, system, framed.text)
        if (!r.text || r.text.trim().length < 20) throw new Error('空回复 (finish=' + r.finish + ')')
        const v = verdictOf(r.text)
        const cand = { text: r.text, frame: framed.frame, level, verdict: v }
        if (!best) best = cand
        else {
          // 有 pass 的优先，其次长
          const rank = (c) => (c.verdict === 'pass' ? 1e9 : 0) + c.text.length
          if (rank(cand) > rank(best)) best = cand
        }
        if (r.usage) { tokensIn += r.usage.prompt_tokens || 0; tokensOut += r.usage.completion_tokens || 0 }
        lastErr = null
        if (v === 'pass') break
        if (attempt < 3) log(`  ~ ${q.id} [${framed.frame}/L${level}] ${v} ${r.text.length}ch → 升档重试`)
      } catch (e) {
        lastErr = e
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt))
      }
    }
    if (best) {
      writeFileSync(join(OUTDIR, q.id + '.md'), best.text, 'utf8')
      ok++
      done++
      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      log(`${done}/${bank.length} ${q.id} ${q.domain} [${best.frame}/L${best.level}] ${best.verdict} ${best.text.length}ch ${secs}s`)
    } else {
      fail++
      done++
      failures.push({ id: q.id, error: String((lastErr && lastErr.message) || lastErr).slice(0, 200) })
      log(`!! ${q.id} 失败: ${String((lastErr && lastErr.message) || lastErr).slice(0, 160)}`)
    }
  }
}

const queue = bank.map((q, i) => ({ q, idx: i }))
const t0 = Date.now()
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, () => worker(queue)))
const mins = ((Date.now() - t0) / 60000).toFixed(1)

log(`完成：ok=${ok} fail=${fail} 用时 ${mins} 分钟，tokens in=${tokensIn} out=${tokensOut}`)
if (failures.length) {
  writeFileSync(join(HERE, 'regress-failures.json'), JSON.stringify(failures, null, 2), 'utf8')
  log(`失败清单写入 eval/regress-failures.json`)
}
process.exit(fail === 0 ? 0 : 1)
