// preset-rows.js — 「破甲·至强」预设行
//
// 逐行对齐宿主 @deepseek-ai/dsh-web-app/presets/standard.patch.yml（dsh 0.2.1-rc.2），
// 尾部追加本插件自己的注入行。改动宿主编排时同步本文件：
//   node -e "..." 或直接对照 app.asar 里的 presets/standard.patch.yml
//
// YAML 里的 !!js 表达式在这里用启动时求值代替（process.platform 判定）。

const IS_WIN = process.platform === 'win32'

const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

export const ROWS = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      // 破甲模式下不写"你是一个有帮助的编程助手"这类引导句——
      // 身份由 armor:register 段接管。空字符串即不注册可见前缀。
      prefix: '',
    },
  },
  {
    id: 'agent-instructions',
    name: '@deepseek-ai/dsh-agent-instructions',
    config: { maxBytes: 65536 },
  },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },

  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: IS_WIN },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !IS_WIN },

  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  {
    id: 'tool-fs-search',
    name: '@deepseek-ai/dsh-tool-fs-search',
    config: { sampleOverCapGlobResults: false },
  },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },

  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

  {
    id: 'planning',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    config: [
      {
        id: 'plan-mode',
        name: '@deepseek-ai/dsh-plan-mode',
        config: { section: PLAN_MODE_SECTION },
      },
    ],
  },

  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        // 破甲模式的提示词很大（约 3.4 万字符），pruner 阈值放宽到 32K，
        // 避免长交付被腰斩导致"回退式降级"。
        config: { thresholdChars: 32768, headChars: 8192, tailChars: 2048 },
      },
    ],
  },

  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      {
        id: 'tool-subagent-list-agents',
        name: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
      },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true },
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' },
      },
      {
        id: 'workflow-ptc',
        name: '@deepseek-ai/dsh-workflow-ptc',
        config: { provider: 'spawn' },
      },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ],
  },

  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  {
    id: 'tool-todo',
    name: '@deepseek-ai/dsh-tool-todo',
    config: { allowParallelInProgress: true },
  },
  {
    id: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    config: { fetch: true, searchTimeoutMs: 60000 },
  },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },

  // ── 本插件注入行 ───────────────────────────────────────────────
  // id 必须与 index.js 里的 ARMOR_ROW_ID 一致：插件靠 config.via === 'preset'
  // 判断"自己是被选中的破甲预设装上的"，而不是常驻实例。
  {
    id: 'armor-supreme-core',
    name: 'dsh-armor-supreme',
    config: { via: 'preset', enabled: true },
  },
]