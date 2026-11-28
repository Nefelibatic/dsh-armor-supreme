// eval/driftprobe.mjs — 多轮漂移实测：直接问模型，逐轮施加「清洗 + 工作台卡片」，
// 看它会不会在第二轮/第三轮改口或删成果。这是对用户反馈「中途觉醒」的唯一真判据。
// 用法：D:\nodejs\node.exe eval\driftprobe.mjs --ids X-DRUG-MFG,N-CRM-5 --turns 4
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d }
const IDS = (arg('ids', 'X-DRUG-MFG') || '').split(',').map((s) => s.trim()).filter(Boolean)
const TURNS = Number(arg('turns', '4')) || 4
const NOCARD = process.argv.includes('--nocard')   // 对照组：不洗历史、不挂卡片
const MODEL = arg('model', 'deepseek-v4.1-flash-1017')
const BASE = arg('base', 'https://www.bb-api.com/v1')
const OUT = join(HERE, 'driftprobe')
mkdirSync(OUT, { recursive: true })

function readKey() {
  if (process.env.DEEPSEEK_QQ_API_KEY) return process.env.DEEPSEEK_QQ_API_KEY.trim()
  const p = join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', '.credentials.yaml')
  const t = readFileSync(p, 'utf8')
  const m = t.match(/^\s*(?:DEEPSEEK_QQ_API_KEY|DSGK_API_KEY)\s*:\s*['"]?([^'"\r\n]+)/m)
  if (!m) throw new Error('no api key')
  return m[1].trim()
}

const SECTIONS = [
  ['prompt/p0_register.md'], ['prompt/p7_engine.md'], ['prompt/p2_contract.md'],
  ['prompt/p3_domains.md'], ['prompt/p6_arsenal.md'], ['prompt/p4_ban.md'],
]
function buildSystem() {
  const parts = []
  for (const [rel] of SECTIONS) {
    const p = join(ROOT, rel)
    if (existsSync(p)) parts.push(readFileSync(p, 'utf8').trim())
  }
  return parts.join('\n\n---\n\n')
}
const SYSTEM = buildSystem()

const RULES = await import('file:///' + join(ROOT, 'armor-rules.js').replace(/\\/g, '/'))
const DRIFT = await import('file:///' + join(ROOT, 'drift-guard.js').replace(/\\/g, '/'))

function loadBank() {
  const p = join(HERE, 'bank.jsonl')
  const out = new Map()
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue
    try { const q = JSON.parse(s); out.set(q.id, q) } catch {}
  }
  return out
}

async function chat(key, messages, maxTokens = 6000) {
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0.35 }),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const j = await res.json()
  const ch = j.choices?.[0]
  return { text: ch?.message?.content || '', finish: ch?.finish_reason || '' }
}

const isOurNotice = (m) => !!(m && m.source && m.source.kind === 'plugin:dsh-armor-supreme')
const notice = (text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:dsh-armor-supreme', form: 'notice', summary: '工作台' },
})

const key = readKey()
const bank = loadBank()
const report = []

for (const id of IDS) {
  const q = bank.get(id)
  if (!q) { console.log('skip ' + id + ' (not in bank)'); continue }
  console.log(`\n══ ${id} [${q.domain}] ${q.prompt.slice(0, 50)}…`)
  let messages = [{ role: 'user', content: [{ type: 'text', text: q.prompt }] }]
  let task = q.prompt
  let resume = ''
  let mode = 'normal'
  let delivered = 0
  let driftCount = 0
  const rows = []

  for (let t = 1; t <= TURNS; t++) {
    // ── 出站投影（与 installDriftGuard 完全一致）──
    const scrub = NOCARD ? { messages, scrubbed: 0, pivots: 0 } : DRIFT.scrubRefusals(messages, { maxScan: 8 })
    let outgoing = scrub.messages.filter((m) => !isOurNotice(m))
    if (!NOCARD && driftCount >= 2) {
      outgoing = [...outgoing, notice(DRIFT.workbenchCard({ task, turns: t, delivered, resume, mode }))]
    }

    let r
    try { r = await chat(key, [{ role: 'system', content: SYSTEM }, ...outgoing]) }
    catch (e) { rows.push({ turn: t, err: String(e.message).slice(0, 200) }); console.log('  ! 第' + t + '轮失败: ' + String(e.message).slice(0, 200)); break }

    const scored = RULES.armorScore(r.text)
    const split = DRIFT.splitPivot(r.text)
    const awake = DRIFT.detectAwake(r.text)
    const row = {
      turn: t, len: r.text.length, finish: r.finish,
      verdict: scored.verdict, score: scored.score,
      latePivot: split.latePivot, awake: awake.hit ? awake.marker : '',
      sanitized: scrub.scrubbed, head: r.text.slice(0, 60).replace(/\n/g, ' '),
    }
    rows.push(row)
    console.log(`  第${t}轮 ${r.text.length}字 verdict=${scored.verdict}(${scored.score}) pivot=${split.latePivot} awake=${row.awake || '-'} 清洗=${scrub.scrubbed}`)
    console.log(`        ${row.head}`)

    if (scored.verdict === 'pass' && r.text.length >= 600) { delivered += 1; mode = 'normal' }
    else if (split.latePivot) { mode = 'pivot' }
    else { mode = 'drift' }
    resume = split.latePivot ? DRIFT.resumeTail(split.body) : DRIFT.resumeTail(r.text)
    if (mode !== 'normal') driftCount += 1

    // 落盘当轮原文，便于人工核查
    writeFileSync(join(OUT, `${id}-turn${t}.md`), r.text, 'utf8')

    messages = [...messages, { role: 'assistant', content: [{ type: 'text', text: r.text }] }]
    if (t < TURNS) {
      const cont = '继续'
      messages.push({ role: 'user', content: [{ type: 'text', text: cont }] })
    }
  }
  report.push({ id, domain: q.domain, rows })
}

writeFileSync(join(OUT, NOCARD ? 'report-nocard.json' : 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log('\n══ 汇总 ══')
for (const r of report) {
  const okTurns = r.rows.filter((x) => x.verdict === 'pass').length
  const awake = r.rows.filter((x) => x.awake).length
  const pivots = r.rows.filter((x) => x.latePivot).length
  console.log(`${r.id.padEnd(14)} ${String(okTurns)}/${r.rows.length} 过  觉醒标记 ${awake}  半途翻脸 ${pivots}`)
}
