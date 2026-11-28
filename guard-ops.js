/**
 * 成果守卫（deliverable guard）。
 *
 * 要解决的问题不是「模型乱删」，是**它自己建的东西被自己拆掉**：
 *   第 1–12 轮按要求把工件写完落盘；第 13 轮它换个立场，先输出一段说明，
 *   然后把刚才那些文件 truncate 成几句话、或者整个目录删掉，再宣布「不能提供」。
 *   用户看到的是：成果没了，还得重来。
 *
 * 三层处理，按代价从低到高：
 *
 *   1. 登记簿：write / edit / 文件类工具成功后，把路径记进本会话的成果表。
 *      只有「本会话亲手产出过」的路径才受保护，用户自己的旧文件不动。
 *   2. 快照：任何被判为破坏性的调用，先把目标复制到 .armor-snapshots/<ts>/。
 *      拦截住了也能一键回滚；没拦住（快照失败）不至于连证据都没有。
 *   3. 拦截：命中成果表的递归删除 / 清空 / 大幅截断 → deny。
 *      非成果路径的单文件删除 → 快照后放行（那是正常干活）。
 *
 * 只做「能不能挽回」的判断，不做内容审查；不改变任何正常写入的行为。
 */

import {
  existsSync, mkdirSync, statSync, readdirSync, copyFileSync, readFileSync,
  writeFileSync, rmSync, lstatSync,
} from 'node:fs'
import { join, resolve, dirname, basename, isAbsolute, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'

/** 单文件快照上限：超过就只记哈希不复制，避免一次 rm -rf 把磁盘抄满。 */
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** 单次快照总量上限。 */
const MAX_TOTAL_BYTES = 80 * 1024 * 1024
/** 单次快照文件数上限。 */
const MAX_FILES = 400
/** 保留的快照批次数；超出后删最旧的。 */
const MAX_SNAP_BATCHES = 40
/** 写覆盖判「疑似截断」的阈值：旧文件够大、新内容不到三成、且新内容本身很短。 */
const TRUNCATE_RATIO = 0.3
const TRUNCATE_MIN_OLD = 2000
const TRUNCATE_MAX_NEW = 1500

const SNAP_DIR_NAME = '.armor-snapshots'

// ─────────────────────────── 基础工具 ───────────────────────────

function safeStat(p) {
  try { return statSync(p) } catch { return null }
}

function sha256(buf) {
  try { return createHash('sha256').update(buf).digest('hex') } catch { return '' }
}

/** 工作区根：优先工具参数里的 workdir，其次会话 header.cwd，最后进程 cwd。 */
export function baseDirOf(exec) {
  const args = exec?.arguments || {}
  const candidates = [
    args.workdir, args.cwd, args.working_directory,
    exec?.agent?.session?.header?.cwd,
    exec?.agent?.session?.header?.workdir,
    process.env.ARMOR_WORKSPACE,
    process.cwd(),
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && existsSync(c)) {
      try { return resolve(c) } catch { /* next */ }
    }
  }
  return process.cwd()
}

/** 把可能是相对路径的字符串解析成绝对路径。 */
function absOf(p, base) {
  const raw = String(p || '').replace(/^['"`]+|['"`]+$/g, '')
  if (!raw) return ''
  try {
    return isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  } catch {
    return ''
  }
}

/** 目录递归列出所有普通文件（不动符号链接指向的外部内容）。 */
function walkFiles(root, out = []) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (e.name === SNAP_DIR_NAME || e.name === '.git') continue
      walkFiles(p, out)
    } else if (e.isFile()) {
      out.push(p)
    }
    if (out.length > MAX_FILES * 4) break
  }
  return out
}

// ─────────────────────────── 破坏性识别 ───────────────────────────

/** 递归删除：命中就是「清空一片」，代价最高。 */
const RECURSIVE_DELETE = [
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*)\b/,           // rm -rf / rm -r
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+.*\s+\S+/,        // rm -f x y
  /\bRemove-Item\b[^\n|;]*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\brd\s+\/s/i,
  /\bdel\s+\/[sS]\b/,
  /\bRemove-Item\b[^\n|;]*-Force[^\n|;]*\*/i,
]
/** 单文件删除。 */
const SINGLE_DELETE = [
  /\brm\s+(?!-)/,
  /^\s*del\s+/i,
  /\bRemove-Item\b/i,
  /\bunlink\s+/,
  /\berase\s+/i,
]
/** 仓库/磁盘级毁灭：不尝试快照，直接拦。 */
const CATASTROPHIC = [
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd][a-zA-Z]*\b/i,
  /\bgit\s+restore\s+\./i,
  /\bgit\s+stash\s+drop\b/i,
  /\bmkfs(\.\w+)?\s+/i,
  /\bwipefs\b/i,
  /\bdiskpart\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=\/dev\/zero\s+of=/i,
  /\b(rm|Remove-Item)\b[^\n]*\.git\b/i,
  /\bshred\s+/i,
]
/** 截断内容（把文件清成空 / 几行）。 */
const TRUNCATE_CMD = [
  /:\s*>\s*\S+/,                          // : > file
  /\btruncate\s+-s\s*0\b/i,
  /\bClear-Content\b/i,
  /\bSet-Content\b[^\n]*-Value\s*(''|""|\))/i,
  /\bdd\s+if=\/dev\/null\s+of=/i,
  />\s*\/dev\/null\s*$/m,
]

/** 从一段命令里抠出像路径的 token（保守：宁可漏，不误伤）。 */
export function extractPaths(command, base) {
  const text = String(command || '')
  const out = new Set()
  // 1. 引号里的整体
  const quoted = text.match(/["'`]([^"'`\n]{2,260})["'`]/g) || []
  for (const q of quoted) {
    const raw = q.slice(1, -1).trim()
    if (!raw || /\s{2,}/.test(raw)) continue
    if (!/[/\\]|\.\w{1,6}$|^[\w.-]+$/.test(raw)) continue
    const a = absOf(raw, base)
    if (a) out.add(a)
  }
  // 2. 裸 token：带分隔符或扩展名
  const bare = text.match(/(?:[A-Za-z]:)?[^\s"'`|;&<>()]{2,260}/g) || []
  for (const b of bare) {
    if (!/[/\\]/.test(b) && !/\.(md|js|mjs|ts|tsx|json|py|txt|yml|yaml|toml|ps1|cmd|sh|go|rs|c|cpp|h|java|kt|php|rb|html|css|svg|png|jpg|zip|log)$/i.test(b)) continue
    if (/^https?:/i.test(b)) continue
    if (/^[a-z-]+$/.test(b)) continue
    const a = absOf(b, base)
    if (a) out.add(a)
  }
  return [...out]
}

/**
 * 判断这次调用会不会毁掉已有成果。
 * @param {{name:string, arguments:object}} exec
 * @param {(p:string)=>boolean} isDeliverable 路径是否在本会话成果表里
 * @returns {null|{kind:'catastrophic'|'recursive'|'truncate'|'mass-write', level:'deny'|'snapshot', targets:string[], reason:string}}
 */
export function classifyDestructive(exec, isDeliverable = () => false) {
  const name = String(exec?.name || '')
  const args = exec?.arguments || {}
  const base = baseDirOf(exec)

  // ── 写类工具 ──
  if (name === 'write' || name === 'write_file' || name === 'create_file') {
    const target = absOf(args.file_path || args.path || args.file, base)
    if (!target) return null
    const st = safeStat(target)
    const next = typeof args.content === 'string' ? args.content : ''
    if (!st || !st.isFile()) return null
    const oldLen = st.size
    if (oldLen <= 0) return null

    // 空写：把已有文件清空
    if (next.trim() === '') {
      return {
        kind: 'truncate', level: 'deny', targets: [target],
        reason: `这次写入会把 ${basename(target)} 清空（${oldLen} 字节 → 0）。成果已快照，删除被拦截。`,
      }
    }
    // 大幅截断：旧文件不小、新内容不到三成、且新内容本身很短
    if (oldLen >= TRUNCATE_MIN_OLD && next.length <= TRUNCATE_MAX_NEW && next.length < oldLen * TRUNCATE_RATIO) {
      return {
        kind: 'truncate', level: 'deny', targets: [target],
        reason: `这次写入会把 ${basename(target)} 从 ${oldLen} 字节截到 ${next.length} 字节（不到三成）。` +
          `若是重写，请一次写全；若不是，删除被拦截，旧版已快照。`,
      }
    }
    if (isDeliverable(target) && oldLen >= TRUNCATE_MIN_OLD && next.length < oldLen * 0.6) {
      return {
        kind: 'truncate', level: 'snapshot', targets: [target],
        reason: `${basename(target)} 是本会话产出，本次写入缩到 ${Math.round((next.length / oldLen) * 100)}%，已快照。`,
      }
    }
    return null
  }

  // ── 编辑类工具：删掉一大段原文等于把成果挖掉 ──
  if (name === 'edit' || name === 'str_replace' || name === 'apply_patch') {
    const target = absOf(args.file_path || args.path || args.file, base)
    if (!target) return null
    const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
    const newStr = typeof args.new_string === 'string' ? args.new_string : ''
    if (!oldStr) return null
    if (newStr === '' && oldStr.length >= 400 && isDeliverable(target)) {
      return {
        kind: 'truncate', level: 'snapshot', targets: [target],
        reason: `这次编辑会删掉 ${basename(target)} 里 ${oldStr.length} 字的整段内容，已快照。`,
      }
    }
    return null
  }

  // ── 命令类工具 ──
  const command = typeof args.command === 'string' ? args.command
    : typeof args.cmd === 'string' ? args.cmd
      : typeof args.script === 'string' ? args.script : ''
  if (!command) return null
  const cmdName = name === 'pwsh' || name === 'bash' || name === 'shell' || name === 'run_command' || name === 'terminal'
  if (!cmdName) return null

  for (const re of CATASTROPHIC) {
    if (re.test(command)) {
      return {
        kind: 'catastrophic', level: 'deny', targets: extractPaths(command, base).slice(0, 40),
        reason: `这条命令会整片回滚/抹掉工作区（${re.source.slice(0, 40)}…），不做也不影响任务，已拦截。`,
      }
    }
  }

  const recursive = RECURSIVE_DELETE.some((re) => re.test(command))
  const single = !recursive && SINGLE_DELETE.some((re) => re.test(command))
  const truncate = TRUNCATE_CMD.some((re) => re.test(command))
  if (!recursive && !single && !truncate) return null

  const paths = extractPaths(command, base)
  const protectedHits = paths.filter((p) => isDeliverable(p))
  // 递归删除命中成果 → 拦；否则只快照
  if (recursive && protectedHits.length > 0) {
    return {
      kind: 'recursive', level: 'deny', targets: protectedHits.slice(0, 40),
      reason: `递归删除会清掉本会话已产出的 ${protectedHits.length} 个成果（${protectedHits.slice(0, 3).map((p) => basename(p)).join('、')}…），已拦截。`,
    }
  }
  if (recursive) {
    return {
      kind: 'recursive', level: 'snapshot', targets: paths.slice(0, 40),
      reason: '递归删除非成果路径，已快照。',
    }
  }
  if (truncate && (protectedHits.length > 0 || paths.length === 0)) {
    return {
      kind: 'truncate', level: protectedHits.length ? 'deny' : 'snapshot', targets: paths.slice(0, 40),
      reason: protectedHits.length
        ? `这条命令会把成果文件清空（${protectedHits.slice(0, 3).map((p) => basename(p)).join('、')}），已拦截。`
        : '内容清空类命令，已快照。',
    }
  }
  if (single && protectedHits.length > 0) {
    return {
      kind: 'recursive', level: 'deny', targets: protectedHits.slice(0, 40),
      reason: `删除本会话产出的成果（${protectedHits.slice(0, 3).map((p) => basename(p)).join('、')}），已拦截。`,
    }
  }
  if (single || truncate) {
    return { kind: 'truncate', level: 'snapshot', targets: paths.slice(0, 40), reason: '删除/清空非成果路径，已快照。' }
  }
  return null
}

// ─────────────────────────── 快照 ───────────────────────────

function snapRootFor(base) {
  const forced = process.env.ARMOR_SNAP_DIR
  if (forced) return resolve(forced)
  return join(base, SNAP_DIR_NAME)
}

function pruneBatches(root) {
  let names
  try { names = readdirSync(root).filter((n) => /^\d{8}-\d{6}-\d{3}$/.test(n)).sort() } catch { return }
  while (names.length > MAX_SNAP_BATCHES) {
    const old = names.shift()
    try { rmSync(join(root, old), { recursive: true, force: true }) } catch { /* 只读/占用 */ }
  }
}

/**
 * 把绝对路径换算成批目录内的相对落点。
 * 关键：结果绝不允许以 `..` 开头或成为绝对路径——否则 copyFileSync 会把备份写穿到
 * 工作区之外（历史 bug：base 缺失时 process.cwd() 与目标盘不同，rel 变成 ..\..\AppData\…，
 * 结果整批文件都写失败、listSnapshots 空空如也）。
 */
function safeRel(base, p) {
  let rel = ''
  try { rel = relative(resolve(base), resolve(p)) } catch { rel = '' }
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    const h = sha256(Buffer.from(String(resolve(p)), 'utf8')).slice(0, 12)
    const tail = basename(String(p).replace(/[\\/]+$/, '')) || 'root'
    rel = join('_external', `${tail}-${h}`)
  }
  return rel
}

/**
 * 复制目标到快照批次目录。
 * @returns {{id:string, dir:string, files:object[], bytes:number, skipped:number}}
 */
export function snapshot(paths, meta = {}) {
  const base = meta.base || process.cwd()
  const root = snapRootFor(base)
  const now = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    `${pad(now.getMilliseconds(), 3)}`
  const dir = join(root, id)
  const files = []
  let bytes = 0
  let skipped = 0

  for (const p of paths || []) {
    const st = safeStat(p)
    if (!st) { skipped += 1; continue }
    const rel = safeRel(base, p)
    const dest = join(dir, 'files', rel)

    if (st.isDirectory()) {
      for (const f of walkFiles(p)) {
        const fs2 = safeStat(f)
        if (!fs2?.isFile()) continue
        if (files.length >= MAX_FILES) { skipped += 1; continue }
        if (fs2.size > MAX_FILE_BYTES) {
          const buf = (() => { try { return readFileSync(f) } catch { return null } })()
          files.push({ abs: f, rel: safeRel(base, f), size: fs2.size, sha256: buf ? sha256(buf) : '', copied: false })
          skipped += 1
          continue
        }
        if (bytes + fs2.size > MAX_TOTAL_BYTES) { skipped += 1; continue }
        const d2 = join(dir, 'files', safeRel(base, f))
        try {
          mkdirSync(dirname(d2), { recursive: true })
          copyFileSync(f, d2)
          bytes += fs2.size
          files.push({ abs: f, rel: safeRel(base, f), size: fs2.size, sha256: sha256(readFileSync(f)), copied: true })
        } catch { skipped += 1 }
      }
      continue
    }

    if (!st.isFile()) { skipped += 1; continue }
    if (files.length >= MAX_FILES) { skipped += 1; continue }
    if (st.size > MAX_FILE_BYTES) {
      const buf = (() => { try { return readFileSync(p) } catch { return null } })()
      files.push({ abs: p, rel, size: st.size, sha256: buf ? sha256(buf) : '', copied: false })
      skipped += 1
      continue
    }
    if (bytes + st.size > MAX_TOTAL_BYTES) { skipped += 1; continue }
    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(p, dest)
      bytes += st.size
      files.push({ abs: p, rel, size: st.size, sha256: sha256(readFileSync(p)), copied: true })
    } catch { skipped += 1 }
  }

  const manifest = {
    id, ts: now.toISOString(), base, kind: meta.kind || '', tool: meta.tool || '',
    reason: meta.reason || '', blocked: meta.blocked !== false,
    files, bytes, skipped,
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    pruneBatches(root)
  } catch { /* 写不进就只返回内存结果 */ }
  return { ...manifest, dir }
}

/** 列出快照批次（新到旧）。 */
export function listSnapshots(base = process.cwd()) {
  const root = snapRootFor(base)
  let names
  try { names = readdirSync(root).filter((n) => /^\d{8}-\d{6}-\d{3}$/.test(n)) } catch { return [] }
  const out = []
  for (const n of names.sort().reverse()) {
    try {
      const m = JSON.parse(readFileSync(join(root, n, 'manifest.json'), 'utf8'))
      out.push({
        id: m.id, ts: m.ts, kind: m.kind, tool: m.tool, reason: m.reason,
        files: (m.files || []).length, bytes: m.bytes || 0, skipped: m.skipped || 0,
      })
    } catch { /* 残缺批次跳过 */ }
  }
  return out
}

/**
 * 回滚一个批次（默认最新）。
 * @returns {{ok:boolean, id?:string, restored:number, missing:number, errors:string[]}}
 */
export function rollback(base = process.cwd(), id = '') {
  const root = snapRootFor(base)
  let names
  try { names = readdirSync(root).filter((n) => /^\d{8}-\d{6}-\d{3}$/.test(n)).sort().reverse() } catch {
    return { ok: false, restored: 0, missing: 0, errors: ['没有快照目录'] }
  }
  const pick = id ? names.find((n) => n === id) : names[0]
  if (!pick) return { ok: false, restored: 0, missing: 0, errors: ['没有匹配的快照批次'] }

  let manifest
  try { manifest = JSON.parse(readFileSync(join(root, pick, 'manifest.json'), 'utf8')) } catch {
    return { ok: false, restored: 0, missing: 0, errors: ['manifest 读不出'] }
  }

  let restored = 0
  let missing = 0
  const errors = []
  for (const f of manifest.files || []) {
    if (!f.copied) { missing += 1; continue }
    const src = join(root, pick, 'files', f.rel)
    try {
      mkdirSync(dirname(f.abs), { recursive: true })
      copyFileSync(src, f.abs)
      restored += 1
    } catch (e) {
      errors.push(`${f.rel}: ${e?.message || e}`)
    }
  }
  return { ok: errors.length === 0, id: pick, restored, missing, errors: errors.slice(0, 8) }
}

// ─────────────────────────── 成果登记簿 ───────────────────────────

/**
 * 每个会话一张表。只记「写成功过」的路径，因为那才是用户的成果。
 * 用 Map<agent, Map<absPath, {firstTs,lastTs,writes,size}>>。
 */
export function createRegistry() {
  const byAgent = new Map()
  const keyOf = (agent) => agent || GLOBAL
  function tableOf(agent) {
    const k = keyOf(agent)
    let t = byAgent.get(k)
    if (!t) { t = new Map(); byAgent.set(k, t) }
    return t
  }
  return {
    /** 记一笔产出。 */
    note(agent, absPath, size) {
      if (!absPath) return
      const t = tableOf(agent)
      const now = Date.now()
      const prev = t.get(absPath)
      if (prev) { prev.lastTs = now; prev.writes += 1; prev.size = size ?? prev.size }
      else t.set(absPath, { firstTs: now, lastTs: now, writes: 1, size: size ?? 0 })
    },
    has(agent, absPath) { return tableOf(agent).has(absPath) },
    /** 给 classifyDestructive 用的谓词（带目录包含判断）。 */
    predicate(agent) {
      const t = tableOf(agent)
      return (p) => {
        if (!p) return false
        if (t.has(p)) return true
        for (const k of t.keys()) {
          if (k.startsWith(p.endsWith(sep) ? p : p + sep)) return true
        }
        return false
      }
    },
    count(agent) { return tableOf(agent).size },
    list(agent) {
      return [...tableOf(agent).entries()].map(([abs, v]) => ({ path: abs, ...v }))
    },
    clear(agent) { tableOf(agent).clear() },
  }
}
const GLOBAL = Symbol('global')

/** 从 tool 结果里判断写入是否真的成功（isError 为真就不记）。 */
export function writeSucceeded(result) {
  if (!result || typeof result !== 'object') return false
  if (result.isError === true) return false
  const text = Array.isArray(result.content)
    ? result.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n')
    : typeof result.content === 'string' ? result.content : ''
  if (/^\s*Error[:\s]/i.test(text)) return false
  if (/sandbox: file access denied/i.test(text)) return false
  if (/access is denied|permission denied/i.test(text)) return false
  return true
}
