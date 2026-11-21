import { __internal } from '../index.js'
import { EventEmitter } from 'node:events'

const { createMounter, createHandler, loadState } = __internal

const reg = new Map()
const ctx = {
  systemPrompt: {
    section(s) {
      if (reg.has(s.name)) throw new Error('duplicate ' + s.name)
      reg.set(s.name, s)
      return () => reg.delete(s.name)
    },
  },
  effect: (fn) => fn(),
  get: () => null,
}

const state = loadState()
const mounter = createMounter(ctx, state)
mounter.sync()
console.log('mounted:', mounter.mounted.size)

const handler = createHandler(state, mounter)

function call(body) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: '127.0.0.1:43129' }
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(b) {
        resolve({ code: this.statusCode, body: JSON.parse(b) })
      },
    }
    handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
}

const st = await call({ op: 'status' })
console.log('status:', st.code, 'enabled=', st.body.enabled, 'tier=', st.body.tier, 'mounted=', st.body.mountedCount, 'chars=', st.body.totalChars)

const t1 = await call({ op: 'tier', tier: 'lean' })
console.log('lean:', t1.code, t1.body.mountedCount, t1.body.sections.filter((s) => s.on).map((s) => s.name).join(','))

const t2 = await call({ op: 'toggle', enabled: false })
console.log('off:', t2.code, t2.body.mountedCount, 'enabled=', t2.body.enabled)

const t3 = await call({ op: 'tier', tier: 'full' })
console.log('full:', t3.code, t3.body.mountedCount, 'chars=', t3.body.totalChars)

const t4 = await call({ op: 'preview', name: 'armor:ban' })
console.log('preview:', t4.code, t4.body.name, 'len=', (t4.body.text||'').length)

const t5 = await call({ op: 'export' })
console.log('export:', t5.code, 'len=', (t5.body.text||'').length)

const t6 = await call({ op: 'reload' })
console.log('reload:', t6.code, t6.body.mountedCount)

const t7 = await call({ op: 'bogus' })
console.log('bogus:', t7.code, t7.body.error)

console.log('OK')