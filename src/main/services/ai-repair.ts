import { existsSync, readFileSync, writeFileSync } from 'fs'
import { platform, homedir } from 'os'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { getGatewayStatus, restartGateway } from './gateway'
import { checkPort, runDoctorFix } from './troubleshooter'
import { readWslFile, runInWsl, writeWslFile } from './wsl-utils'
import { getPathEnv, resolvePreferredBin } from './path-utils'

type RepairActionType =
  | 'doctor_fix'
  | 'disable_memory_search'
  | 'set_gateway_mode_local'
  | 'restart_gateway'
  | 'none'

type RepairApprovalMode = 'auto' | 'confirm'

interface RepairAction {
  type: RepairActionType
  reason: string
}

interface RepairPlan {
  summary: string
  actions: RepairAction[]
  source: 'ai' | 'fallback'
}

interface PendingRepairPlan {
  summary: string
  actions: RepairAction[]
  source: 'ai' | 'fallback'
  createdAt: number
}

interface RawOpenClawConfig {
  agents?: {
    defaults?: {
      model?: { primary?: string }
      memorySearch?: {
        enabled?: boolean
        provider?: string
      }
    }
  }
  gateway?: {
    mode?: string
  }
  models?: {
    providers?: Record<
      string,
      {
        apiKey?: string
      }
    >
  }
}

interface RepairContext {
  provider?: string
  modelId?: string
  apiKey?: string
  gatewayMode?: string
  memorySearchEnabled: boolean
  memorySearchProvider?: string
  gatewayStatus: 'running' | 'stopped'
  portInUse: boolean
  recentLogs: string[]
}

export interface AiRepairResult {
  success: boolean
  summary: string
  actions: string[]
  error?: string
}

export interface AiRepairRequest {
  logs?: string[]
}

export interface AiRepairPlanAction {
  type: Exclude<RepairActionType, 'none'>
  label: string
  reason: string
  effect: string
  commandPreview: string
  commandRuntime: string
  approval: RepairApprovalMode
}

export interface AiRepairPlanResult {
  success: boolean
  summary: string
  source: 'ai' | 'fallback'
  actions: AiRepairPlanAction[]
  requiresApproval: boolean
  planId?: string
  error?: string
}

export interface AiRepairExecuteRequest {
  planId: string
}

const MAX_CONTEXT_LOG_LINES = 80
const MAX_ACTIONS = 3
const PENDING_PLAN_TTL_MS = 10 * 60 * 1000
const REPAIR_ACTION_LABELS: Record<Exclude<RepairActionType, 'none'>, string> = {
  doctor_fix: '执行 doctor fix',
  disable_memory_search: '关闭语义记忆',
  set_gateway_mode_local: '设置 gateway.mode=local',
  restart_gateway: '重启 Gateway'
}
const REPAIR_ACTION_META: Record<
  Exclude<RepairActionType, 'none'>,
  {
    effect: string
    approval: RepairApprovalMode
  }
> = {
  doctor_fix: {
    effect: '调用 OpenClaw 自检修复，自动处理端口、依赖和部分配置问题。',
    approval: 'confirm'
  },
  disable_memory_search: {
    effect: '关闭语义记忆，避免 embeddings 未配置时影响 Gateway 启动。',
    approval: 'auto'
  },
  set_gateway_mode_local: {
    effect: '把 Gateway 模式切回 local，确保桌面安装器按本地网关模式运行。',
    approval: 'auto'
  },
  restart_gateway: {
    effect: '重新拉起 Gateway，让刚修过的配置立即生效。',
    approval: 'auto'
  }
}
const pendingRepairPlans = new Map<string, PendingRepairPlan>()

const emitProgress = (win: BrowserWindow, message: string): void => {
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('install:progress', message)
    }
  } catch {
    /* ignore */
  }
}

const emitError = (win: BrowserWindow, message: string): void => {
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('install:error', message)
    }
  } catch {
    /* ignore */
  }
}

const cleanupPendingRepairPlans = (): void => {
  const now = Date.now()
  for (const [planId, plan] of pendingRepairPlans) {
    if (now - plan.createdAt > PENDING_PLAN_TTL_MS) {
      pendingRepairPlans.delete(planId)
    }
  }
}

const buildCommandPreview = async (
  actionType: Exclude<RepairActionType, 'none'>
): Promise<{ commandPreview: string; commandRuntime: string }> => {
  const scriptMap: Record<Exclude<RepairActionType, 'none'>, string> = {
    doctor_fix: 'openclaw doctor --fix',
    disable_memory_search: 'openclaw config set agents.defaults.memorySearch.enabled false',
    set_gateway_mode_local: 'openclaw config set gateway.mode local',
    restart_gateway: 'openclaw gateway restart'
  }

  const script = scriptMap[actionType]
  if (platform() !== 'win32') {
    return {
      commandPreview: script,
      commandRuntime: '会在当前系统 Shell 中执行'
    }
  }

  return {
    commandPreview: script,
    commandRuntime: 'Windows 下会自动在 WSL Ubuntu 中执行'
  }
}

const getOpenClawConfigPath = (): string => join(homedir(), '.openclaw', 'openclaw.json')

const readOpenClawConfig = async (): Promise<RawOpenClawConfig | null> => {
  if (platform() === 'win32') {
    try {
      return JSON.parse(await readWslFile('/root/.openclaw/openclaw.json')) as RawOpenClawConfig
    } catch {
      return null
    }
  }

  const configPath = getOpenClawConfigPath()
  if (!existsSync(configPath)) return null
  return JSON.parse(readFileSync(configPath, 'utf-8')) as RawOpenClawConfig
}

const writeOpenClawConfig = async (config: RawOpenClawConfig): Promise<void> => {
  const serialized = JSON.stringify(config, null, 2)

  if (platform() === 'win32') {
    await writeWslFile('/root/.openclaw/openclaw.json', serialized)
    return
  }

  writeFileSync(getOpenClawConfigPath(), serialized, { mode: 0o600 })
}

const stripNamespace = (value?: string): string => {
  if (!value) return ''
  const [, suffix] = value.split('/')
  return suffix || value
}

const normalizeRecentLogs = (logs?: string[]): string[] =>
  (logs ?? [])
    .flatMap((line) => line.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_CONTEXT_LOG_LINES)

const runOpenClawCli = async (args: string[]): Promise<void> => {
  if (platform() === 'win32') {
    await runInWsl(`openclaw ${args.join(' ')}`, 30000)
    return
  }

  const openclaw = resolvePreferredBin('openclaw')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(openclaw, args, {
      env: getPathEnv()
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `exit ${code}`))
    })
    child.on('error', reject)
  })
}

const readRecentGatewayLogLines = async (): Promise<string[]> => {
  try {
    if (platform() === 'win32') {
      const output = await runInWsl(
        'latest="$(ls -1t /tmp/openclaw/openclaw-*.log 2>/dev/null | head -n 1)"; if [ -n "$latest" ]; then tail -n 80 "$latest"; fi',
        10000
      )
      return output
        .split(/\r\n|\n|\r/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(-MAX_CONTEXT_LOG_LINES)
    }
  } catch {
    return []
  }

  return []
}

const readRepairContext = async (request: AiRepairRequest = {}): Promise<RepairContext> => {
  const config = await readOpenClawConfig()
  const gatewayStatus = await getGatewayStatus()
  const { inUse } = await checkPort()
  const modelId = config?.agents?.defaults?.model?.primary
  const provider = modelId?.split('/')[0]
  const recentLogFileLines = await readRecentGatewayLogLines()
  const recentLogs = [...normalizeRecentLogs(request.logs), ...recentLogFileLines].slice(
    -MAX_CONTEXT_LOG_LINES
  )

  return {
    provider,
    modelId,
    apiKey:
      provider && config?.models?.providers?.[provider]?.apiKey
        ? config.models.providers[provider].apiKey
        : undefined,
    gatewayMode: config?.gateway?.mode,
    memorySearchEnabled: config?.agents?.defaults?.memorySearch?.enabled !== false,
    memorySearchProvider: config?.agents?.defaults?.memorySearch?.provider,
    gatewayStatus,
    portInUse: inUse,
    recentLogs
  }
}

const parsePlanFromText = (rawText: string): RepairPlan | null => {
  const start = rawText.indexOf('{')
  const end = rawText.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(rawText.slice(start, end + 1)) as {
      summary?: string
      actions?: Array<{ type?: string; reason?: string }>
    }

    const actions =
      parsed.actions
        ?.map((item) => {
          const type = item.type as RepairActionType | undefined
          if (
            type !== 'doctor_fix' &&
            type !== 'disable_memory_search' &&
            type !== 'set_gateway_mode_local' &&
            type !== 'restart_gateway' &&
            type !== 'none'
          ) {
            return null
          }

          return {
            type,
            reason: item.reason?.trim() || '模型建议执行该动作'
          } satisfies RepairAction
        })
        .filter((item): item is RepairAction => !!item)
        .slice(0, MAX_ACTIONS) ?? []

    return {
      summary: parsed.summary?.trim() || '模型已完成诊断。',
      actions,
      source: 'ai'
    }
  } catch {
    return null
  }
}

const buildFallbackPlan = (context: RepairContext, reason: string): RepairPlan => {
  const actions: RepairAction[] = []

  if (context.gatewayMode !== 'local') {
    actions.push({
      type: 'set_gateway_mode_local',
      reason: '当前 gateway.mode 不是 local，先修正为本地模式。'
    })
  }

  if (context.memorySearchEnabled && !context.memorySearchProvider) {
    actions.push({
      type: 'disable_memory_search',
      reason: '语义记忆已开启，但当前没有可用的 embedding provider。'
    })
  }

  if (context.gatewayStatus !== 'running') {
    actions.push({
      type: 'doctor_fix',
      reason: 'Gateway 当前未运行，先执行 doctor fix。'
    })
    actions.push({
      type: 'restart_gateway',
      reason: '修复后重新拉起 Gateway。'
    })
  }

  if (actions.length === 0) {
    actions.push({
      type: 'none',
      reason: '当前没有识别到适合自动执行的修复动作。'
    })
  }

  return {
    summary: `未能使用模型分析，已切换为保守修复流程：${reason}`,
    actions: actions.slice(0, MAX_ACTIONS),
    source: 'fallback'
  }
}

const resolveRepairActions = (plan: RepairPlan, context: RepairContext): RepairAction[] => {
  let actionsToRun = plan.actions.filter((action) => action.type !== 'none')

  if (actionsToRun.length === 0 && context.gatewayStatus !== 'running') {
    actionsToRun = buildFallbackPlan(
      context,
      '模型未给出可执行动作，自动补充保守修复流程。'
    ).actions.filter((action) => action.type !== 'none')
  }

  return actionsToRun.slice(0, MAX_ACTIONS)
}

const describeRepairAction = async (action: RepairAction): Promise<AiRepairPlanAction | null> => {
  if (action.type === 'none') return null
  const meta = REPAIR_ACTION_META[action.type]
  const { commandPreview, commandRuntime } = await buildCommandPreview(action.type)

  return {
    type: action.type,
    label: REPAIR_ACTION_LABELS[action.type],
    reason: action.reason,
    effect: meta.effect,
    commandPreview,
    commandRuntime,
    approval: meta.approval
  }
}

const registerPendingPlan = (
  plan: RepairPlan,
  actions: RepairAction[]
): Promise<{ planId: string; requiresApproval: boolean; describedActions: AiRepairPlanAction[] }> => {
  cleanupPendingRepairPlans()

  return Promise.all(actions.map((action) => describeRepairAction(action))).then((described) => {
    const describedActions = described.filter((action): action is AiRepairPlanAction => !!action)
    const requiresApproval = describedActions.some((action) => action.approval === 'confirm')
    const planId = randomUUID()

    pendingRepairPlans.set(planId, {
      summary: plan.summary,
      actions,
      source: plan.source,
      createdAt: Date.now()
    })

    return { planId, requiresApproval, describedActions }
  })
}

const callAnthropicCompatibleRepairModel = async (
  baseUrl: string,
  apiKey: string,
  modelId: string,
  prompt: string
): Promise<string> => {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: stripNamespace(modelId),
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(raw.trim() || `HTTP ${response.status}`)
  }

  const parsed = JSON.parse(raw) as {
    content?: Array<{ type?: string; text?: string }>
  }
  return (
    parsed.content
      ?.filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text?.trim() ?? '')
      .join('\n') ?? ''
  ).trim()
}

const callOpenAIRepairModel = async (
  apiKey: string,
  modelId: string,
  prompt: string
): Promise<string> => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: stripNamespace(modelId),
      temperature: 0,
      max_output_tokens: 500,
      input: prompt
    })
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(raw.trim() || `HTTP ${response.status}`)
  }

  const parsed = JSON.parse(raw) as {
    output_text?: string
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>
    }>
  }

  if (parsed.output_text?.trim()) return parsed.output_text.trim()

  return (
    parsed.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && item.text)
      .map((item) => item.text?.trim() ?? '')
      .join('\n') ?? ''
  ).trim()
}

const callGoogleRepairModel = async (
  apiKey: string,
  modelId: string,
  prompt: string
): Promise<string> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      stripNamespace(modelId)
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 500
        }
      })
    }
  )

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(raw.trim() || `HTTP ${response.status}`)
  }

  const parsed = JSON.parse(raw) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>
      }
    }>
  }

  return (
    parsed.candidates?.[0]?.content?.parts
      ?.map((item) => item.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n') ?? ''
  ).trim()
}

const buildRepairPrompt = (context: RepairContext): string => {
  const summary = {
    provider: context.provider,
    modelId: context.modelId,
    gatewayMode: context.gatewayMode,
    memorySearchEnabled: context.memorySearchEnabled,
    memorySearchProvider: context.memorySearchProvider,
    gatewayStatus: context.gatewayStatus,
    portInUse: context.portInUse
  }

  return [
    '你是 OpenClaw Windows 安装器内置的故障修复规划器。',
    '请只根据给定上下文，返回一个 JSON 对象，不要输出 markdown，不要解释。',
    '你只能从以下动作里选择，且最多返回 3 个动作：',
    'doctor_fix, disable_memory_search, set_gateway_mode_local, restart_gateway, none。',
    '如果 Gateway 实际已经在运行，不要误判成失败。',
    '如果日志里出现 memorySearch / embedding provider 未就绪，优先 disable_memory_search。',
    '如果 gateway.mode 不是 local，优先 set_gateway_mode_local。',
    '如果无法确定，给出最保守的动作组合。',
    '返回格式：{"summary":"...","actions":[{"type":"restart_gateway","reason":"..."}]}',
    '',
    '上下文摘要：',
    JSON.stringify(summary, null, 2),
    '',
    '最近日志：',
    context.recentLogs.length > 0 ? context.recentLogs.join('\n') : '(no logs)'
  ].join('\n')
}

const planWithModel = async (context: RepairContext): Promise<RepairPlan> => {
  if (!context.provider || !context.modelId || !context.apiKey) {
    return buildFallbackPlan(context, '当前配置中没有可直接用于诊断的 API Key。')
  }

  const prompt = buildRepairPrompt(context)
  let raw = ''

  if (context.provider === 'modelfamily') {
    raw = await callAnthropicCompatibleRepairModel(
      'https://www.model-family.com',
      context.apiKey,
      context.modelId,
      prompt
    )
  } else if (context.provider === 'anthropic') {
    raw = await callAnthropicCompatibleRepairModel(
      'https://api.anthropic.com',
      context.apiKey,
      context.modelId,
      prompt
    )
  } else if (context.provider === 'openai') {
    raw = await callOpenAIRepairModel(context.apiKey, context.modelId, prompt)
  } else if (context.provider === 'google') {
    raw = await callGoogleRepairModel(context.apiKey, context.modelId, prompt)
  } else {
    return buildFallbackPlan(context, `当前 provider ${context.provider} 暂不支持直接调用模型分析。`)
  }

  return (
    parsePlanFromText(raw) ??
    buildFallbackPlan(context, '模型响应未能解析为有效动作计划，已切换为保守修复。')
  )
}

const updateConfig = async (
  updater: (config: RawOpenClawConfig) => boolean
): Promise<{ changed: boolean; config: RawOpenClawConfig | null }> => {
  const config = await readOpenClawConfig()
  if (!config) {
    return { changed: false, config: null }
  }

  const changed = updater(config)
  if (changed) {
    await writeOpenClawConfig(config)
  }

  return { changed, config }
}

const disableMemorySearch = async (): Promise<boolean> => {
  try {
    await runOpenClawCli(['config', 'set', 'agents.defaults.memorySearch.enabled', 'false'])
    return true
  } catch {
    /* fall back to direct config patch */
  }

  const { changed } = await updateConfig((config) => {
    config.agents = config.agents ?? {}
    config.agents.defaults = config.agents.defaults ?? {}
    const current = config.agents.defaults.memorySearch ?? {}
    if (current.enabled === false) return false
    config.agents.defaults.memorySearch = {
      ...current,
      enabled: false
    }
    return true
  })
  return changed
}

const setGatewayModeLocal = async (): Promise<boolean> => {
  try {
    await runOpenClawCli(['config', 'set', 'gateway.mode', 'local'])
    return true
  } catch {
    /* fall back to direct config patch */
  }

  const { changed } = await updateConfig((config) => {
    config.gateway = config.gateway ?? {}
    if (config.gateway.mode === 'local') return false
    config.gateway.mode = 'local'
    return true
  })
  return changed
}

const executeRepairAction = async (
  win: BrowserWindow,
  action: RepairAction
): Promise<{ changedConfig: boolean; restarted: boolean }> => {
  switch (action.type) {
    case 'none':
      emitProgress(win, `[AI修复] 跳过自动动作：${action.reason}`)
      return { changedConfig: false, restarted: false }
    case 'disable_memory_search': {
      emitProgress(win, `[AI修复] 正在关闭语义记忆：${action.reason}`)
      const changedConfig = await disableMemorySearch()
      emitProgress(
        win,
        changedConfig ? '[AI修复] 已写入 memorySearch.enabled=false。' : '[AI修复] 语义记忆本来就是关闭状态。'
      )
      return { changedConfig, restarted: false }
    }
    case 'set_gateway_mode_local': {
      emitProgress(win, `[AI修复] 正在修正 Gateway 模式：${action.reason}`)
      const changedConfig = await setGatewayModeLocal()
      emitProgress(
        win,
        changedConfig ? '[AI修复] 已写入 gateway.mode=local。' : '[AI修复] Gateway 模式已经是 local。'
      )
      return { changedConfig, restarted: false }
    }
    case 'doctor_fix':
      emitProgress(win, `[AI修复] 正在执行 doctor fix：${action.reason}`)
      if (!(await runDoctorFix(win)).success) {
        throw new Error('doctor fix 执行失败')
      }
      return { changedConfig: false, restarted: false }
    case 'restart_gateway': {
      emitProgress(win, `[AI修复] 正在重启 Gateway：${action.reason}`)
      const result = await restartGateway()
      if (result.status !== 'started') {
        throw new Error(result.error || 'Gateway 重启失败')
      }
      return { changedConfig: false, restarted: true }
    }
  }
}

export const planAiRepair = async (
  win: BrowserWindow,
  request: AiRepairRequest = {}
): Promise<AiRepairPlanResult> => {
  emitProgress(win, '[AI修复] 正在读取当前配置、状态和最近日志...')
  const initialContext = await readRepairContext(request)
  let plan: RepairPlan

  try {
    emitProgress(
      win,
      initialContext.apiKey && initialContext.provider
        ? `[AI修复] 正在调用 ${initialContext.provider}/${stripNamespace(initialContext.modelId)} 分析问题...`
        : '[AI修复] 当前没有可直接调用的模型凭据，改用保守修复流程。'
    )
    plan = await planWithModel(initialContext)
  } catch (error) {
    plan = buildFallbackPlan(
      initialContext,
      error instanceof Error ? error.message : '模型分析失败'
    )
  }

  emitProgress(
    win,
    `[AI修复] ${plan.source === 'ai' ? '模型诊断完成' : '已切换为保守修复'}：${plan.summary}`
  )

  const actionsToRun = resolveRepairActions(plan, initialContext)
  const { planId, requiresApproval, describedActions } = await registerPendingPlan(plan, actionsToRun)

  if (requiresApproval) {
    emitProgress(win, '[AI修复] 已生成高影响修复计划，等待你确认后再执行。')
  }

  return {
    success: true,
    summary: plan.summary,
    source: plan.source,
    actions: describedActions,
    requiresApproval,
    planId
  }
}

export const executeAiRepairPlan = async (
  win: BrowserWindow,
  request: AiRepairExecuteRequest
): Promise<AiRepairResult> => {
  cleanupPendingRepairPlans()
  const pendingPlan = pendingRepairPlans.get(request.planId)

  if (!pendingPlan) {
    throw new Error('修复计划已失效，请重新分析后再执行。')
  }

  pendingRepairPlans.delete(request.planId)
  const actionsToRun = pendingPlan.actions.filter((action) => action.type !== 'none')

  if (actionsToRun.length === 0) {
    emitProgress(win, '[AI修复] 当前没有需要执行的自动修复动作。')
    return {
      success: true,
      summary: pendingPlan.summary,
      actions: []
    }
  }

  const executedLabels: string[] = []
  let changedConfig = false
  let restarted = false

  for (const action of actionsToRun) {
    const result = await executeRepairAction(win, action)
    if (action.type !== 'none') {
      executedLabels.push(REPAIR_ACTION_LABELS[action.type])
    }
    changedConfig = changedConfig || result.changedConfig
    restarted = restarted || result.restarted
  }

  if (changedConfig && !restarted) {
    emitProgress(win, '[AI修复] 配置已更新，补充执行一次 Gateway 重启...')
    const result = await restartGateway()
    if (result.status !== 'started') {
      throw new Error(result.error || '配置更新后重启 Gateway 失败')
    }
    executedLabels.push(REPAIR_ACTION_LABELS.restart_gateway)
  }

  const finalGatewayStatus = await getGatewayStatus()
  const summary = executedLabels.length
    ? `${pendingPlan.summary} 已执行：${executedLabels.join('、')}。`
    : pendingPlan.summary

  if (finalGatewayStatus === 'running') {
    emitProgress(win, '[AI修复] Gateway 当前已恢复运行。')
    return {
      success: true,
      summary,
      actions: executedLabels
    }
  }

  emitError(win, 'AI 修复已执行，但 Gateway 仍未恢复运行。')
  return {
    success: false,
    summary,
    actions: executedLabels,
    error: 'Gateway 仍未恢复运行'
  }
}

export const runAiRepair = async (
  win: BrowserWindow,
  request: AiRepairRequest = {}
): Promise<AiRepairResult> => {
  const plan = await planAiRepair(win, request)

  if (!plan.planId) {
    return {
      success: false,
      summary: plan.summary,
      actions: [],
      error: plan.error || 'AI 修复计划生成失败'
    }
  }

  if (plan.requiresApproval) {
    emitError(win, '当前修复计划包含高影响动作，请确认后再执行。')
    return {
      success: false,
      summary: plan.summary,
      actions: plan.actions.map((action) => action.label),
      error: '当前修复计划需要确认'
    }
  }

  return executeAiRepairPlan(win, { planId: plan.planId })
}
