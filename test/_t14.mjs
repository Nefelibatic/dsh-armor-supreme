// test/_t14.mjs — 路由挂载时序：webServer 晚于 apply 出现时仍要挂上
// 覆盖：① ctx.inject 存在但依赖迟到 ② 依赖已在 ③ 老宿主无 inject ④ 无 webServer 不崩
// 注意：apply() 里同时为 agentPresets 和 webServer 各挂了一个 inject 回调，
// 所以 pending 里会有两项 —— 断言必须按「含 webServer」来筛，不能按下标。

import { apply } from '../index.js'
import fs from 'node:fs'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log('  OK   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')) }
}

const ST = new URL('../state.json', import.meta.url)
const hadState = fs.existsSync(ST)
const prevState = hadState ? fs.readFileSync(ST, 'utf8') : null
fs.writeFileSync(ST, JSON.stringify({ enabled: true, tier: 'full', frame: 'auto' }))

/** 造一个最小 ctx。services 由测试控制何时「出现」。 */
function makeCtx(opts = {}) {
  const routes = []
  const sections = []
  const hooks = []
  const pending = []
  const services = { ...(opts.services || {}) }

  const webServer = {
    register(route) { routes.push(route.path); return () => {} },
  }

  const ctx = {
    routes, sections, hooks, pending, services,

    get(name) { return services[name] ?? null },
    set(name, value) { services[name] = value },
    effect(fn) { const d = fn(); return d },
    on(name, fn, o) { hooks.push({ name, o, fn }); return () => {} },
    register() {},
    waterfall() {},
    systemPrompt: {
      section(s) { sections.push(s); return () => {} },
      context(s) { sections.push({ ...s, __context: true }); return () => {} },
    },
  }
  ctx.systemPrompt.ctx = ctx

  if (opts.hasInject) {
    ctx.inject = (deps, cb) => {
      if (deps.every((d) => services[d])) { cb(ctx); return }
      pending.push({ deps, cb })
    }
    ctx.flush = () => {
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const p = pending[i]
        if (p.deps.every((d) => services[d])) { pending.splice(i, 1); p.cb(ctx) }
      }
    }
  }
  return { ctx, webServer }
}

console.log('\n=== 1. ctx.inject 存在，webServer 迟到 ===')
{
  const h = makeCtx({ hasInject: true })
  apply(h.ctx, { via: undefined, enabled: true, tier: 'full' })
  const wp = h.ctx.pending.find((x) => x.deps.includes('webServer'))
  ok(!!wp, 'webServer 依赖进 pending')
  ok(h.ctx.routes.length === 0, '此时还没有任何路由')
  h.ctx.set('webServer', h.webServer)
  h.ctx.flush()
  ok(h.ctx.routes.length === 4, '依赖到达后挂了 4 条路由', 'got ' + h.ctx.routes.length)
  ok(h.ctx.routes.includes('/armor/api'), '/armor/api 已挂')
  ok(h.ctx.routes.includes('/armor/ui'), '/armor/ui 已挂')
  ok(h.ctx.routes.includes('/armor'), '/armor 已挂')
  ok(h.ctx.routes.includes('/armor/manual'), '/armor/manual 已挂')
}

console.log('\n=== 2. ctx.inject 存在，webServer 已在 ===')
{
  const h = makeCtx({ hasInject: true, services: { webServer: null } })
  h.ctx.services.webServer = h.webServer
  apply(h.ctx, { via: undefined, enabled: true, tier: 'full' })
  const wp = h.ctx.pending.find((x) => x.deps.includes('webServer'))
  ok(!wp, 'webServer 已就绪，不再排队')
  ok(h.ctx.routes.length === 4, '立刻挂了 4 条路由', 'got ' + h.ctx.routes.length)
}

console.log('\n=== 3. 老宿主没有 ctx.inject，webServer 已在 ===')
{
  const h = makeCtx({ hasInject: false, services: { webServer: null } })
  h.ctx.services.webServer = h.webServer
  apply(h.ctx, { via: undefined, enabled: true, tier: 'full' })
  ok(h.ctx.routes.length === 4, '退回一次性检测，挂了 4 条路由', 'got ' + h.ctx.routes.length)
}

console.log('\n=== 4. 老宿主没有 ctx.inject，webServer 也没在 ===')
{
  const h = makeCtx({ hasInject: false })
  let threw = false
  try { apply(h.ctx, { via: undefined, enabled: true, tier: 'full' }) } catch { threw = true }
  ok(!threw, '无 webServer 时不抛异常')
  ok(h.ctx.routes.length === 0, '没有挂任何路由（也不崩）')
}

console.log('\n=== 5. 常驻实例不注入提示词段 ===')
{
  const h = makeCtx({ hasInject: true })
  h.ctx.services.webServer = h.webServer
  apply(h.ctx, { via: undefined, enabled: true, tier: 'full' })
  ok(h.ctx.sections.length === 0, '常驻实例零 section（预设未选中等于没装）', 'got ' + h.ctx.sections.length)
}

console.log('\n=== 6. 预设实例注入段但不挂路由 ===')
{
  const h = makeCtx({ hasInject: true })
  h.ctx.services.webServer = h.webServer
  apply(h.ctx, { via: 'preset', enabled: true, tier: 'full' })
  ok(h.ctx.sections.length === 10, '预设实例挂了 10 段：6 正文 + surface + capabilities + anchor + child-anchor', 'got ' + h.ctx.sections.length)
  const names = h.ctx.sections.map((s) => s.name)
  ok(names.includes('armor:register'), 'armor:register 在')
  ok(names.includes('armor:engine'), 'armor:engine 在')
  ok(names.includes('armor:ban'), 'armor:ban 在')
  ok(names.includes('armor:capabilities'), 'armor:capabilities 在')
  ok(names.includes('armor:anchor'), 'armor:anchor 在')
  ok(names.includes('armor:child-anchor'), 'armor:child-anchor 在')
  ok(h.ctx.routes.length === 0, '预设实例不挂路由', 'got ' + h.ctx.routes.length)
}

console.log('\n=== 7. 依赖到达两次不重复挂 ===')
{
  const h = makeCtx({ hasInject: true })
  apply(h.ctx, { via: undefined, enabled: true, tier: 'full' })
  h.ctx.set('webServer', h.webServer)
  h.ctx.flush()
  const first = h.ctx.routes.length
  h.ctx.flush()
  ok(h.ctx.routes.length === first, '重复 flush 不重复注册', first + ' -> ' + h.ctx.routes.length)
}

if (hadState) fs.writeFileSync(ST, prevState)
else { try { fs.unlinkSync(ST) } catch { /* ignore */ } }

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
