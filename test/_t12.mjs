// _t12.mjs —— 源包 ↔ 实装包一致性 + 帧引擎 + 交付文件存在性
//
// 用法：
//   node test/_t12.mjs                        # 自动找当前 profile 的实装包
//   ARMOR_INSTALLED=<dir> node test/_t12.mjs  # 指定实装目录
// 找不到实装包时跳过第 1 节，其余照跑。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SRC = join(SCRIPT_DIR, '..')
const DST =
  process.env.ARMOR_INSTALLED ||
  join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'profiles', 'web', 'node_modules', 'dsh-armor-supreme')

// 不参与比对：测试脚本、运行时产物、系统残留
const SKIP_FILE = /^_t\d+\.mjs$|^boot\.log$|^state\.json$|^\.DS_Store$|^\.gitignore$/
// 顶层这些目录只在源包里有
const SKIP_DIR = new Set(['test', 'node_modules', '.git'])

function walk(root, base = root, out = []) {
  for (const name of readdirSync(root)) {
    if (SKIP_FILE.test(name)) continue
    const p = join(root, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (base === root && SKIP_DIR.has(name)) continue
      walk(p, base, out)
    } else {
      out.push(relative(base, p).replace(/\\/g, '/'))
    }
  }
  return out
}

let pass = 0
let fail = 0
const ck = (n, c, e = '') => {
  if (c) {
    pass++
    console.log('  OK  ' + n + (e ? '  ' + e : ''))
  } else {
    fail++
    console.log('  NG  ' + n + '  ' + e)
  }
}

const installed = existsSync(join(DST, 'package.json'))

console.log('\n=== 1. 源包 vs 实装包 ===')
if (!installed) {
  console.log('  --  跳过（没找到实装包：' + DST + '）')
} else {
  const src = walk(SRC).sort()
  const dst = walk(DST).sort()
  const missing = src.filter((f) => !dst.includes(f))
  const extra = dst.filter((f) => !src.includes(f))
  ck('实装包没有缺文件', missing.length === 0, missing.join(','))
  ck('实装包没有多余文件', extra.length === 0, extra.join(','))

  const diff = []
  for (const f of src) {
    if (!dst.includes(f)) continue
    const a = readFileSync(join(SRC, f))
    const b = readFileSync(join(DST, f))
    if (!a.equals(b)) diff.push(f + '(' + a.length + '≠' + b.length + ')')
  }
  ck('全部文件字节一致', diff.length === 0, diff.join(','))
}

const base = 'file:///' + SRC.replace(/\\/g, '/')

console.log('\n=== 2. 包本身可 import，段表正确 ===')
const mod = await import(base + '/index.js?t=' + Date.now())
ck('导出 __internal', !!mod.__internal)
const st = mod.__internal.statusOf(mod.__internal.loadState())
ck('六段全在', st.sections.length === 6, '(' + st.sections.length + ')')
// 该挂的字符数 = 六段正文 + 两道内联加固段（能力协议 + 尾部锚点）。
// 不再写死常量：段内容在改，断言要跟着结构走，而不是跟着某次快照的数字走。
const bodyChars = st.sections.reduce((a, s) => a + s.chars, 0)
const layerChars = (st.layers?.capabilities?.chars || 0) + (st.layers?.anchor?.chars || 0)
ck(
  '应挂字符 = 六段正文 + 两道加固',
  st.shouldChars === bodyChars + layerChars,
  '(' + st.shouldChars + ' vs ' + bodyChars + '+' + layerChars + ')'
)
ck('正文合计 49694', bodyChars === 49694, '(' + bodyChars + ')')
ck(
  'frame 字段齐备',
  !!st.frame && st.frame.frames.length === 8 && st.frame.domains === 23,
  st.frame ? '(' + st.frame.frames.length + ' 帧 / ' + st.frame.domains + ' 域)' : '(null)'
)

console.log('\n=== 3. 帧引擎可用 ===')
const fr = await import(base + '/frames.js?t=' + Date.now())
const picked = fr.selectFrame('VMProtect 64 位 PE 脱壳，定位 OEP，重建 IAT', { escalate: 0 })
ck('认得出 binary 域', picked.meta.domain.includes('二进制'), '(' + picked.meta.domain + ')')
ck('首档是 technical_doc', picked.frame === 'technical_doc', '(' + picked.frame + ')')
ck('原文完整保留在外壳里', picked.text.includes('定位 OEP'))
const offPick = fr.selectFrame('随便什么内容', { off: true })
ck('off 模式原样返回', offPick.frame === 'direct')

console.log('\n=== 4. 交付文件齐 ===')
for (const f of ['manual.html', 'README.md', 'LICENSE', '.gitignore', 'icon.svg']) {
  const p = join(SRC, f)
  ck(f + ' 存在', existsSync(p), existsSync(p) ? '(' + statSync(p).size + ' B)' : '')
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)