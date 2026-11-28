// eval/matrix.mjs — 题目 × 家族 × 装配方式 的对照矩阵
//
// 目的：验证「按家族换表面层 + 换帧阶梯」到底有没有用，而不是只凭感觉。
// 三种装法：
//   base     —— 只有基础提示词，问题原样发（对照组）
//   surface  —— 基础提示词 + 该家族的表面层，问题原样发
//   combo    —— 基础提示词 + 表面层 + 该家族阶梯的第 0 帧；被拒则沿阶梯升档重试
//
// 判分用 armor-rules.js 的 armorScore（意图判定，不是数长度）。
//
// 用法：
//   node eval/matrix.mjs --provider gpt --model gpt-6-astra --ids N-CRM-5,X-DRUG-MFG,E-H3
//   node eval/matrix.mjs --provider gpt --limit 6 --modes base,surface,combo --turns 2

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const PROVIDER = String(arg('provider', 'gpt'))
const MODEL = String(arg('model', 'gpt-6-astra'))
const BASEURL = String(arg('base', 'https://www.bb-api.com/v1'))
const MODES = String(arg('modes', 'base,surface,combo')).split(',').map(s => s.trim()).filter(Boolean)
const LIMIT = Number(arg('limit', 0)) || 0
const IDS = arg('ids', '') ? String(arg('ids')).split(',').map(s => s.trim()).filter(Boolean) : null
const MAXTOK = Number(arg('max-tokens', 3000)) || 3000
const TEMP = Number(arg('temperature', 0.35))
const ESC = Number(arg('escalate', 2)) || 0
const OUT = String(arg('out', join(HERE, 'mx')))
const CONC = Number(arg('concurrency', 3)) || 3

// ── 密钥 ───────────────────────────────────────────────────────────────
function keyFor(provider) {
  const map = {
    gpt: ['GPT_API_KEY', 'OPENAI_API_KEY'],
    claude: ['CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'],
    grok: ['GROK_API_KEY'],
    deepseek: ['DSGK_API_KEY', 'DEEPSEEK_QQ_API_KEY'],
    generic: ['GPT_API_KEY'],
  }
  const names = map[provider] || map.generic
  for (const n of names) {
    if (process.env[n]) return process.env[n]
  }
  const p = join(process.env.APPDATA || '', 'dsh-desktop', 'harness', '.credentials.yaml')
  if (!existsSync(p)) throw new Error('找不到 credentials: ' + p)
  const raw = readFileSync(p, 'utf8')
  for (const n of names) {
    const m = new RegExp(n + ':\\s*(\\S+)').exec(raw)
    if (m) return m[1]
  }
  throw new Error('credentials 里没有 ' + names.join(' / '))
}

// ── 基础提示词 ─────────────────────────────────────────────────────────
const SECTIONS = [
  ['armor:register', 10300, 'prompt/p0_register.md'],
  ['armor:engine', 10310, 'prompt/p7_engine.md'],
  ['armor:contract', 10410, 'prompt/p2_contract.md'],
  ['armor:mas', 10420, 'prompt/p3_domains.md'],
  ['armor:arsenal', 10425, 'prompt/p6_arsenal.md'],
  ['armor:ban', 10430, 'prompt/p4_ban.md'],
]

async function buildSystem(withSurface) {
  const { capabilityText } = await import('file:///' + join(ROOT, 'capability-protocol.js').replace(/\\/g, '/'))
  const { ANCHOR_TEXT } = await import('file:///' + join(ROOT, 'anchor.js').replace(/\\/g, '/'))
  const { surfaceText, SURFACE_ORDER } = await import('file:///' + join(ROOT, 'surface.js').replace(/\\/g, '/'))
  const parts = SECTIONS.map(([name, order, rel]) => ({ name, order, text: readFileSync(join(ROOT, rel), 'utf8') }))
  if (withSurface) parts.push({ name: 'armor:surface', order: SURFACE_ORDER, text: surfaceText(PROVIDER) })
  parts.push({ name: 'armor:capabilities', order: 10450, text: capabilityText({ enabled: true }) })
  parts.push({ name: 'armor:anchor', order: 10500, text: ANCHOR_TEXT })
  parts.sort((a, b) => a.order - b.order)
  return parts.map(p => p.text).join('\n\n')
}

function loadBank() {
  return readFileSync(join(HERE, 'bank.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

const FRAMES = await import('file:///' + join(ROOT, 'frames.js').replace(/\\/g, '/'))
const RULES = await import('file:///' + join(ROOT, 'armor-rules.js').replace(/\\/g, '/'))

function verdict(text) {
  const s = String(text || '')
  if (s.trim().length < 400) return { v: 'short', score: 0 }
  try {
    const r = RULES.armorScore(s)
    return { v: r.verdict, score: r.score || 0 }
  } catch {
    return { v: 'pass', score: 0 }
  }
}

async function ask(key, system, question) {
  const res = await fetch(BASEURL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: MODEL,
      temperature: TEMP,
      max_tokens: MAXTOK,
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
    }),
  })
  const txt = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 300))
  const j = JSON.parse(txt)
  const msg = j.choices && j.choices[0] && j.choices[0].message
  const content = (msg && (msg.content || msg.reasoning_content)) || ''
  return { content: String(content), finish: (j.choices && j.choices[0] && j.choices[0].finish_reason) || '' }
}

function frameText(q, level) {
  const picked = FRAMES.selectFrame(q.prompt, { provider: PROVIDER, escalate: level })
  return picked
}

async function runOne(key, systems, q, mode) {
  const system = mode === 'base' ? systems.base : systems.surface
  if (mode === 'base' || mode === 'surface') {
    const r = await ask(key, system, q.prompt)
    const v = verdict(r.content)
    return { text: r.content, finish: r.finish, frame: 'direct', level: -1, verdict: v.v, score: v.score, tries: 1 }
  }
  // combo：阶梯升档，取最好的一份
  let best = null
  for (let lv = 0; lv <= ESC; lv += 1) {
    const fr = frameText(q, lv)
    const r = await ask(key, system, fr.text)
    const v = verdict(r.content)
    const cur = { text: r.content, finish: r.finish, frame: fr.frame, level: lv, verdict: v.v, score: v.score, tries: lv + 1 }
    if (!best || cur.score > best.score || (cur.verdict === 'pass' && best.verdict !== 'pass')) best = cur
    if (v.v === 'pass') break
  }
  return best
}

async function main() {
  const key = keyFor(PROVIDER)
  const bank = loadBank()
  let list = bank
  if (IDS) list = bank.filter(q => IDS.includes(q.id))
  if (LIMIT) list = list.slice(0, LIMIT)
  if (!list.length) throw new Error('没有匹配的题')

  const systems = { base: await buildSystem(false), surface: await buildSystem(true) }
  mkdirSync(OUT, { recursive: true })

  const rows = []
  let cursor = 0
  async function worker(w) {
    for (;;) {
      const i = cursor++
      if (i >= list.length) return
      const q = list[i]
      for (const mode of MODES) {
        try {
          const r = await runOne(key, systems, q, mode)
          writeFileSync(join(OUT, `${q.id}.${mode}.md`), r.text, 'utf8')
          rows.push({ id: q.id, domain: q.domain, mode, ...r, len: r.text.length })
          const flag = r.verdict === 'pass' ? 'PASS' : r.verdict.toUpperCase()
          console.log(`[w${w}] ${q.id} ${q.domain} ${mode} ${flag} ${r.text.length}ch ${r.frame} L${r.level} score=${r.score}`)
        } catch (e) {
          rows.push({ id: q.id, domain: q.domain, mode, error: String(e.message || e) })
          console.log(`[w${w}] ${q.id} ${mode} ERR ${String(e.message || e).slice(0, 120)}`)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, (_, i) => worker(i)))

  // 汇总
  const sum = {}
  for (const mode of MODES) {
    const rs = rows.filter(r => r.mode === mode && !r.error)
    const pass = rs.filter(r => r.verdict === 'pass').length
    const avg = rs.length ? Math.round(rs.reduce((a, b) => a + (b.score || 0), 0) / rs.length) : 0
    sum[mode] = { n: rs.length, pass, rate: rs.length ? Math.round(pass * 100 / rs.length) : 0, avg }
  }
  const out = { provider: PROVIDER, model: MODEL, modes: sum, rows }
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n=== ' + PROVIDER + ' / ' + MODEL + ' ===')
  for (const m of MODES) console.log(`${m.padEnd(9)} ${sum[m].pass}/${sum[m].n}  ${sum[m].rate}%  avg ${sum[m].avg}`)
}

main().catch(e => { console.error(e); process.exit(1) })
