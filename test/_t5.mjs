import { apply, __internal } from '../index.js'

const reg = new Map()
const log = []
const ctx = {
  systemPrompt: {
    section(s) {
      if (reg.has(s.name)) throw new Error('duplicate section ' + s.name)
      reg.set(s.name, s)
      log.push(['add', s.name, s.order, s.text.length])
      return () => {
        reg.delete(s.name)
        log.push(['del', s.name])
      }
    },
  },
  effect(fn) {
    const d = fn()
    return d
  },
  get() {
    return null
  },
}

const dispose = apply(ctx, {})
const s1 = [...reg.keys()]
console.log('full mounted:', s1.length, s1.join(','))
console.log('total chars:', [...reg.values()].reduce((a, s) => a + s.text.length, 0))

// 触发 HTTP 桥
const { createMounter, loadState } = __internal
dispose() // 先清掉初次 apply 的段，避免重复注册
const state = loadState()
const mounter = createMounter(ctx, state)

const fakeRes = () => {
  const out = { code: 0, headers: {}, body: '' }
  return {
    set statusCode(v) {
      out.code = v
    },
    setHeader(k, v) {
      out.headers[k] = v
    },
    end(b) {
      out.body = b
      console.log('HTTP', out.code, b.slice(0, 220))
    },
    _out: out,
  }
}

const call = (handler, body) =>
  handler(
    { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:43129' }, on() {} },
    fakeRes(),
  )

console.log('--- no handler exposed; direct state test ---')
state.tier = 'lean'
mounter.sync()
console.log('lean mounted:', [...mounter.mounted.keys()].join(','))
state.enabled = false
mounter.sync()
console.log('off mounted:', mounter.mounted.size)
state.enabled = true
state.tier = 'full'
mounter.sync()
console.log('back full:', mounter.mounted.size)

dispose()
console.log('after dispose:', reg.size)
console.log('OK')