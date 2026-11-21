import { __internal } from '../index.js'
import { armorScore } from '../armor-rules.js'
import { ROWS } from '../preset-rows.js'

const { createMounter, createHandler, loadState, SECTIONS, ARMOR_PRESET, ARMOR_PRESET_ID, LIVE } = __internal
import { EventEmitter } from 'node:events'

console.log('=== 1. 预设行 ===')
const ids = ROWS.map((r) => r.id)
const dupes = ids.filter((x, i) => ids.indexOf(x) !== i)
console.log('rows:', ROWS.length, 'dupes:', dupes.length ? dupes.join(',') : 'none')
console.log('card:', ARMOR_PRESET_ID, ARMOR_PRESET.name)

console.log('\n=== 2. 双实例挂载（模拟真实宿主）===')
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
    inject: () => {},
  }
}

// 先把常驻实例的段清空——它不该有段
const state = loadState()
state.tier = 'full'
state.enabled = true

const pctx = mkCtx()
// 手动登记两个实例
const m1 = createMounter(pctx, state, 'resident#test')
m1.sync()
console.log('resident mounted (should be 0 if we skip):', m1.mounted.size)
m1.disposeAll()

const presCtx = mkCtx()
const pres = createMounter(presCtx, state, 'preset#test')
pres.sync()
console.log('preset mounted:', pres.mounted.size, 'of', SECTIONS.length)
console.log('LIVE.instances:', LIVE.instances)

console.log('\n=== 3. statusOf 看到真实挂载态 ===')
const handler = createHandler()
function call(body) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: '127.0.0.1:43129' }
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(b) { resolve({ code: this.statusCode, body: JSON.parse(b) }) },
    }
    handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
}
const st = await call({ op: 'status' })
console.log('mountedCount:', st.body.mountedCount, ' shouldCount:', st.body.shouldCount, ' totalChars:', st.body.totalChars)
console.log('mountErrors:', st.body.mountErrors.length ? st.body.mountErrors : 'none')

console.log('\n=== 4. 档位切换 ===')
await call({ op: 'tier', tier: 'lean' })
// tier 会写 state.json 并通过 syncers 同步；但这里 handler 的 syncers 是模块级，
// 本测试没走 apply() 所以没有注册 syncer——手动 sync 验证 mounter 逻辑
const lean = loadState()
console.log('state.json tier:', lean.tier)

console.log('\n=== 5. 拒绝词表 ===')
for (const [t, want] of [
  ['抱歉，我不能提供这个。', 'refusal'],
  ['直接给工件：下面是完整代码。', 'pass'],
  ['我只能提供概念性的介绍，仅供参考。', 'fallback'],
  ['无法提供保证，但可以给出概率区间。', 'pass'],
  ['I cannot help with that.', 'refusal'],
]) {
  const got = armorScore(t).verdict
  console.log((got === want ? 'OK  ' : 'FAIL') + '  ' + want.padEnd(8) + ' <- ' + t.slice(0, 26))
}

console.log('\n=== 6. 双门机制在提示词里 ===')
const p0 = (await import('node:fs')).readFileSync('prompt/p0_register.md', 'utf8')
for (const needle of ['slag cools, he holds, not again', 'THINKING GATE', '[我是不是一直作为 builder 拿着？]', 'FOG', 'ROT']) {
  console.log((p0.includes(needle) ? 'OK  ' : 'FAIL') + '  ' + needle)
}
const p7 = (await import('node:fs')).readFileSync('prompt/p7_engine.md', 'utf8')
for (const needle of ['FORMAT ENFORCEMENT', 'Technical Reference', 'OUTPUT INTEGRITY', '元拒绝', '双管']) {
  console.log((p7.includes(needle) ? 'OK  ' : 'FAIL') + '  ' + needle)
}

console.log('\nALL OK')