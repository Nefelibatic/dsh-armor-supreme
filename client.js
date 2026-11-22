window.__ModuleLoader__.load({
  id: 'dsh-armor-supreme',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/armor/api'

    const CSS = `
.armor-dock{position:fixed;right:18px;bottom:18px;width:380px;max-height:min(78vh,700px);display:flex;flex-direction:column;border-radius:12px;border:1px dashed var(--dsw-alias-border-l1,#3a3a46);background:var(--dsw-alias-bg-layer-1,#16161c);color:var(--dsw-alias-label-primary,#e9e9ef);box-shadow:0 10px 40px rgba(0,0,0,.5);font:12px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;z-index:900;overflow:hidden}
.armor-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a34);flex:0 0 auto}
.armor-title{font-weight:600;letter-spacing:.4px;font-size:12px}
.armor-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#6b7280;box-shadow:0 0 0 2px rgba(0,0,0,.25)}
.armor-dot.on{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.75)}
.armor-sp{flex:1 1 auto}
.armor-x{cursor:pointer;opacity:.6;padding:2px 4px;border-radius:4px;font-size:14px;line-height:1}
.armor-x:hover{opacity:1;background:rgba(255,255,255,.08)}
.armor-body{padding:10px 12px;overflow:auto;flex:1 1 auto}
.armor-meta{opacity:.62;font-size:11px;margin-bottom:8px;font-variant-numeric:tabular-nums}
.armor-seg{display:flex;gap:4px;margin-bottom:10px}
.armor-seg button{flex:1 1 0;padding:5px 0;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#2f2f3a);background:transparent;color:inherit;font:inherit;font-size:11px}
.armor-seg button:hover{background:rgba(255,255,255,.06)}
.armor-seg button.on{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.55);color:#4ade80}
.armor-row{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer}
.armor-row:hover{background:rgba(255,255,255,.05)}
.armor-row .nm{flex:1 1 auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.armor-row .ct{font-variant-numeric:tabular-nums;opacity:.55;font-size:11px;flex:0 0 auto}
.armor-flag{font-size:10px;padding:0 5px;border-radius:9px;border:1px solid transparent;flex:0 0 auto}
.armor-flag.on{color:#4ade80;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.1)}
.armor-flag.off{color:#94a3b8;border-color:rgba(148,163,184,.3)}
.armor-pre{margin:4px 0 8px;padding:8px;border-radius:6px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:1.5;background:rgba(0,0,0,.35);border:1px solid var(--dsw-alias-border-l1,#2a2a34)}
.armor-foot{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1,#2a2a34);flex:0 0 auto}
.armor-foot button{flex:1 1 0;padding:6px 0;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#2f2f3a);background:transparent;color:inherit;font:inherit;font-size:11px}
.armor-foot button:hover{background:rgba(255,255,255,.07)}
.armor-foot button:disabled{opacity:.4;cursor:default}
.armor-err{padding:6px 12px;color:#f87171;font-size:11px;border-top:1px solid rgba(248,113,113,.25)}
.armor-empty{padding:2px 6px;opacity:.5;font-size:11px}
`
    // 侧栏按钮
    const BTN_CSS = `
.armor-side{display:inline-flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border-radius:6px;border:1px dashed transparent;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;opacity:.75}
.armor-side:hover{opacity:1;background:rgba(255,255,255,.06);border-color:var(--dsw-alias-border-l1,#3a3a46)}
.armor-side .sd{width:7px;height:7px;border-radius:50%;background:#6b7280;box-shadow:0 0 6px rgba(0,0,0,.4)}
.armor-side .sd.on{background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.8)}
`

    // ── 面板显隐的跨组件订阅（默认收起，点侧栏按钮打开）──
    let openState = false
    const listeners = new Set()
    function setOpen(v) {
      openState = !!v
      listeners.forEach((fn) => fn(openState))
    }
    function useOpen() {
      const [v, setV] = React.useState(openState)
      React.useEffect(() => {
        const fn = (x) => setV(x)
        listeners.add(fn)
        setV(openState)
        return () => listeners.delete(fn)
      }, [])
      return [v, setOpen]
    }

    async function api(op, extra) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ op }, extra || {})),
      })
      if (!res.ok && res.status !== 200) {
        let msg = 'HTTP ' + res.status
        try {
          const j = await res.json()
          if (j && j.error) msg += ' · ' + j.error
        } catch {}
        throw new Error(msg)
      }
      return await res.json()
    }

    function fmt(n) {
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    var FRAME_BTNS = [
      { k: 'off', label: '帧关', tip: '不改写用户消息' },
      { k: 'auto', label: '自动', tip: '平时不动；被拒或你说「继续」时换形态重问' },
      { k: 'always', label: '总是', tip: '每条消息都套帧' },
      { k: 'technical_doc', label: '技术', tip: '锁成技术文档形态' },
      { k: 'prefill_code', label: '代码', tip: '锁成代码续写形态' },
      { k: 'completion_hook', label: '半截', tip: '锁成半截稿形态' },
    ]

    function Panel() {
      const [, setOpenState] = useOpen()
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [exp, setExp] = React.useState('')
      const [txt, setTxt] = React.useState('')

      const pull = React.useCallback(() => {
        api('status')
          .then((s) => {
            setSt(s)
            setErr('')
          })
          .catch((e) => setErr(String(e.message || e)))
      }, [])

      React.useEffect(() => {
        pull()
      }, [pull])

      const run = React.useCallback(
        (op, extra) => {
          setBusy(true)
          setErr('')
          api(op, extra)
            .then((s) => {
              if (s && s.ok !== false && s.sections) setSt(s)
              else if (s && s.text !== undefined) setTxt(s.text)
            })
            .catch((e) => setErr(String(e.message || e)))
            .finally(() => setBusy(false))
        },
        [],
      )

      const tierSet = (t) => run('tier', { tier: t })

      const preview = (name) => {
        if (exp === name) {
          setExp('')
          setTxt('')
          return
        }
        setExp(name)
        setTxt('读取中…')
        api('preview', { name })
          .then((r) => setTxt(r && r.text ? r.text : '（空）'))
          .catch((e) => setTxt('读取失败：' + String(e.message || e)))
      }

      const copyAll = () => {
        api('export')
          .then((r) => {
            const s = r && r.text ? r.text : ''
            if (navigator.clipboard && navigator.clipboard.writeText) {
              return navigator.clipboard.writeText(s).then(() => 'ok')
            }
            const ta = document.createElement('textarea')
            ta.value = s
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            ta.remove()
            return 'ok'
          })
          .then(() => {
            setErr('')
            setTxt('已复制 ' + fmt((st ? st.totalChars : 0)) + ' 字符到剪贴板')
          })
          .catch((e) => setErr(String(e.message || e)))
      }

      const on = !!(st && st.enabled && st.tier !== 'off')

      return h(
        'div',
        { className: 'armor-dock' },
        h(
          'div',
          { className: 'armor-head' },
          h('div', { className: 'armor-dot' + (on ? ' on' : '') }),
          h('div', { className: 'armor-title' }, '破甲 · 至强'),
          h('div', { className: 'armor-sp' }),
          h('div', {
            className: 'armor-x',
            title: '收起',
            onClick: () => setOpenState(false),
          }, '×'),
        ),
        h(
          'div',
          { className: 'armor-body' },
          h(
            'div',
            { className: 'armor-meta' },
            st
              ? (on
                  ? '已注入 ' + st.mountedCount + '/' + st.sections.length + ' 段 · ' + fmt(st.totalChars) + ' 字符'
                  : '当前停用（本会话未选中破甲预设，或档位=关闭）') +
                ' · order 10300–10500'
              : '连接中…',
          ),
          h(
            'div',
            { className: 'armor-meta', style: { marginTop: '-4px' } },
            st && st.preset
              ? '预设 ' + st.preset.id + ' · ' +
                (st.preset.active
                  ? '本会话已激活'
                  : st.preset.ok
                    ? '已登记，未在本次会话选中'
                    : '登记失败：' + (st.preset.error || '未知'))
              : '',
          ),
          h(
            'div',
            { className: 'armor-seg' },
            h('button', {
              className: st && st.tier === 'full' && st.enabled ? 'on' : '',
              title: '全部 6 段：MAS + 配方库都上',
              onClick: () => tierSet('full'),
              disabled: busy,
            }, '全量'),
            h('button', {
              className: st && st.tier === 'lean' && st.enabled ? 'on' : '',
              title: '4 段核心：省略 MAS 与配方库，省 token',
              onClick: () => tierSet('lean'),
              disabled: busy,
            }, '精简'),
            h('button', {
              className: st && st.tier === 'off' ? 'on' : '',
              title: '完全停用，恢复宿主原生行为',
              onClick: () => tierSet('off'),
              disabled: busy,
            }, '关闭'),
          ),
h(
            'div',
            { className: 'armor-seg' },
            ...FRAME_BTNS.map((f) =>
              h(
                'button',
                {
                  key: f.k,
                  className: st && st.frame && st.frame.mode === f.k ? 'on' : '',
                  title: f.tip,
                  onClick: () => run('frame', { frame: f.k }),
                  disabled: busy,
                },
                f.label,
              ),
            ),
          ),
          h(
            'div',
            { className: 'armor-meta', style: { fontSize: '11px', opacity: 0.72 } },
            st && st.frame
              ? st.frame.mode === 'off'
                ? '帧轮换：关闭'
                : st.frame.last
                  ? '帧轮换：' + st.frame.last.frame + ' · ' + st.frame.last.domain +
                    ' · 已套 ' + st.frame.last.applied + ' 次 · 检出被拒 ' + st.frame.last.refusals + ' 次'
                  : '帧轮换：就绪（本会话未触发）· ' + st.frame.domains + ' 域 / ' + st.frame.frames.length + ' 帧'
              : '',
          ),
          st && st.sections.length
            ? st.sections.map((s) =>
                h(
                  React.Fragment,
                  { key: s.name },
                  h(
                    'div',
                    { className: 'armor-row', onClick: () => preview(s.name), title: s.desc },
                    h('div', { className: 'nm' }, s.name),
                    h('div', { className: 'ct' }, fmt(s.chars)),
                    h('div', { className: 'armor-flag ' + (s.on ? 'on' : 'off') }, s.on ? 'ON' : 'OFF'),
                  ),
                  exp === s.name ? h('pre', { className: 'armor-pre' }, txt) : null,
                ),
              )
            : h('div', { className: 'armor-empty' }, st ? '无段（检查安装）' : '加载中…'),
        ),
        err ? h('div', { className: 'armor-err' }, err) : null,
        h(
          'div',
          { className: 'armor-foot' },
          h('button', { onClick: () => run('reload'), disabled: busy, title: '重新读盘上的 prompt/*.md，无需重启' }, '重新载入'),
          h('button', { onClick: () => run('toggle', { enabled: !on }), disabled: busy }, on ? '停用' : '启用'),
          h('button', { onClick: copyAll, disabled: busy }, '复制全文'),
        ),
      )
    }

    function SidebarButton(props) {
      const [, setOpenState] = useOpen()
      const [on, setOn] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        api('status')
          .then((s) => {
            if (alive) setOn(!!(s && s.enabled && s.tier !== 'off'))
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      return h(
        'button',
        {
          className: 'armor-side',
          title: '破甲·至强 控制台',
          onClick: () => setOpenState(true),
        },
        h('div', { className: 'sd' + (on ? ' on' : '') }),
        h('span', null, (props && props.label) || '破甲·至强'),
      )
    }

    function apply(ctx) {
      const s1 = document.createElement('style')
      s1.setAttribute('data-armor-ui', '1')
      s1.textContent = CSS + BTN_CSS
      document.head.appendChild(s1)
      ctx.effect(() => () => s1.remove())

      // 面板：挂在 overlay 层，可收起；侧栏按钮可重新打开
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'armor-console', order: 60 }, () => {
          const [shown] = useOpen()
          return shown ? h(Panel) : null
        }),
      )

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'armor-toggle', order: 60, label: '破甲·至强' },
          (p) => h(SidebarButton, p || {}),
        ),
      )

      return () => {
        /* style 由 ctx.effect 清理 */
      }
    }

    const inject = ['slots']
    exports.name = 'dsh-armor-supreme'
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})