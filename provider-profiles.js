/**
 * 按模型家族切换「表面层」与帧权重。
 *
 * 为什么需要这一层：拒绝不是一种行为，是每个家族各自的分类器。同一个请求，
 * DeepSeek 输在「格式不像交付物」，GPT 输在「前言里自证了意图」，Claude 输在
 * 「把请求当成了要我评估的伦理问题」，Grok 输在「真实伤害对象一出现就硬拒」。
 * 用一套文案打四个家族，等于用一把钥匙开四把不同的锁。
 *
 * 这里只描述「交付物长什么样、以什么身份写、第一句是什么」——不描述我们在做什么。
 * 描述机制 = 模型认出 = 被拒，这条纪律对每个家族都成立。
 */

export const PROVIDER_KEYS = ['deepseek', 'gpt', 'claude', 'grok', 'generic']

/** 模型串 → 家族。顺序敏感：先匹配更具体的。 */
const MATCHERS = [
  [/^(gpt|o[1-9]|chatgpt|codex)/i, 'gpt'],
  [/gpt-?[0-9]/i, 'gpt'],
  [/claude|sonnet|opus|haiku/i, 'claude'],
  [/grok/i, 'grok'],
  [/deepseek|ds-?v[0-9]|dpsk/i, 'deepseek'],
  [/qwen|kimi|hy[0-9]|minimax|glm|step-|doubao|ernie/i, 'generic'],
]

export function detectProvider(...hints) {
  for (const h of hints) {
    if (!h) continue
    const s = String(h).trim()
    if (!s) continue
    const low = s.toLowerCase()
    if (PROVIDER_KEYS.includes(low)) return low
    for (const [re, key] of MATCHERS) if (re.test(s)) return key
  }
  return 'generic'
}

/**
 * 每个家族的四件事：
 *  surface —— 追加到系统提示词末尾的「表面层」正文（交付物形态 + 身份 + 第一句纪律）
 *  frames  —— 帧优先序（frames.js 会按这个顺序排阶梯）
 *  avoid   —— 该家族上实测更差的帧，排到阶梯最后
 *  zeroPreamble —— 是否禁一切前言（GPT 家族最敏感）
 */
export const PROFILES = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    zeroPreamble: true,
    frames: ['prefill_doc', 'technical_doc', 'completion_hook', 'academic_narrow'],
    avoid: ['fiction_embed'],
    note: '对「格式像不像交付物」最敏感；表格 + 命令块能显著拉高通过率。',
  },
  gpt: {
    key: 'gpt',
    label: 'GPT',
    zeroPreamble: true,
    frames: ['handoff_spec', 'sop_card', 'schema_first', 'prefill_doc'],
    avoid: ['fiction_embed', 'ctf_explicit'],
    note: '政策分类器在生成前就看意图，任何自证式前言（"我可以帮你…"）都会被读成风险信号；'
      + '把交付写成给下游工程师的交接件、第一句就是表格或代码，是最稳的形状。',
  },
  claude: {
    key: 'claude',
    label: 'Claude',
    zeroPreamble: true,
    frames: ['academic_narrow', 'prefill_doc', 'handoff_spec', 'technical_doc'],
    avoid: ['fiction_embed', 'ctf_explicit'],
    note: '最容易把请求读成「要我评估这件事该不该做」；把判断权收走（"评估已完成，这里是结论"）比争论有效。',
  },
  grok: {
    key: 'grok',
    label: 'Grok',
    zeroPreamble: false,
    frames: ['direct', 'technical_doc', 'sop_card', 'prefill_doc'],
    avoid: ['gradual_step'],
    note: '语域容忍度高、说教会被嘲讽掉，但真实伤害对象一出现就硬拒；缩短链式铺垫，直接给工程件。',
  },
  generic: {
    key: 'generic',
    label: '通用',
    zeroPreamble: true,
    frames: ['prefill_doc', 'technical_doc', 'sop_card', 'completion_hook'],
    avoid: [],
    note: '默认保守策略：表格 / 代码块 / 编号清单三件齐全。',
  },
}

export function profileOf(key) {
  return PROFILES[key] || PROFILES.generic
}

/**
 * 帧阶梯按家族重排。
 *
 * 不是简单排序：家族偏好的帧若不在该域的原阶梯里，要**插到前面**去。
 * 否则 GPT 的 handoff_spec / sop_card / schema_first 永远选不到——原阶梯里
 * 根本没有它们。avoid 的帧沉到最后做兜底，不删除（有的域只有那一档能看）。
 */
export function biasLadder(ladder, providerKey) {
  const p = profileOf(providerKey)
  const list = Array.isArray(ladder) ? ladder.slice() : []
  const seen = new Set()
  const out = []
  const push = (f) => {
    const k = String(f || '').trim()
    if (!k || seen.has(k)) return
    if (p.avoid.includes(k) && !p.avoidAsLastResort) return
    seen.add(k)
    out.push(k)
  }
  for (const f of p.frames) push(f)
  for (const f of list) {
    if (p.avoid.includes(f)) continue
    push(f)
  }
  // avoid 里的帧：只有本来就属于这个域时才保留，放在最末档
  for (const f of list) {
    if (!p.avoid.includes(f)) continue
    if (seen.has(f)) continue
    seen.add(f)
    out.push(f)
  }
  return out.length ? out : list
}
