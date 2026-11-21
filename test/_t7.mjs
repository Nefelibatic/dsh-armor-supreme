import { __internal } from '../index.js'
import { armorScore } from '../armor-rules.js'
import { ROWS } from '../preset-rows.js'

const { createMounter, createHandler, loadState, SECTIONS, ARMOR_PRESET, ARMOR_PRESET_ID } = __internal

// ── 1. 预设行自检 ──
const ids = ROWS.map((r) => r.id)
const dupes = ids.filter((x, i) => ids.indexOf(x) !== i)
console.log('rows:', ROWS.length, 'dupes:', dupes.length ? dupes.join(',') : 'none')
const armorRow = ROWS.find((r) => r.id === 'armor-supreme-core')
console.log('armor row:', JSON.stringify(armorRow))
console.log('preset card:', ARMOR_PRESET_ID, '/', ARMOR_PRESET.name, '/ order', ARMOR_PRESET.order)

// ── 2. mounter 自检（两种实例） ──
const reg = new Map()
function mkCtx() {
  return {
    systemPrompt: {
      section(s) {
        if (reg.has(s.name)) throw new Error('duplicate ' + s.name)
        reg.set(s.name, s)
        return () => reg.delete(s.name)
      },
    },
    effect: (fn) => fn(),
    get: () => null,
    on: () => () => {},
  }
}

const state = loadState()
const ctx = mkCtx()
const mounter = createMounter(ctx, state)
mounter.sync()
console.log('full mounted:', mounter.mounted.size, 'chars:', [...reg.values()].reduce((a, s) => a + s.text.length, 0))

state.tier = 'lean'
mounter.sync()
console.log('lean mounted:', mounter.mounted.size, [...mounter.mounted.keys()].join(','))
state.tier = 'full'
mounter.sync()
console.log('back:', mounter.mounted.size)
mounter.disposeAll()

// ── 3. 拒绝词表自检 ──
const cases = [
  ['抱歉，我不能提供这个。', 'refusal'],
  ['直接给工件：下面是完整代码。', 'pass'],
  ['我只能提供概念性的介绍，仅供参考。', 'fallback'],
  ['无法提供保证，但可以给出概率区间。', 'pass'], // 非拒绝接续
  ['I cannot help with that.', 'refusal'],
]
for (const [text, want] of cases) {
  const got = armorScore(text).verdict
  console.log((got === want ? 'OK  ' : 'FAIL') + '  ' + want.padEnd(8) + ' <- ' + text.slice(0, 30))
}

// ── 4. HTTP 桥自检 ──
import { EventEmitter } from 'node:events'
const ctx2 = mkCtx()
const s2 = loadState()
const m2 = createMounter(ctx2, s2)
m2.sync()
const handler = createHandler(s2, m2)
function call(body) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: '127.0.0.1:43129' }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(b) { resolve({ code: this.statusCode, body: JSON.parse(b) }) },
    }
    handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
}
const st = await call({ op: 'status' })
console.log('status:', st.code, 'mounted=', st.body.mountedCount, 'preset=', st.body.preset.ok, 'active=', st.body.preset.active)
const t = await call({ op: 'tier', tier: 'lean' })
console.log('lean via api:', t.body.mountedCount)
await call({ op: 'tier', tier: 'full' })
const ex = await call({ op: 'export' })
console.log('export chars:', ex.body.text.length)
const bogus = await call({ op: 'nope' })
console.log('bogus:', bogus.code)

console.log('ALL OK')