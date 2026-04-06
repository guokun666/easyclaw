import { existsSync, readFileSync, writeFileSync } from 'fs'
import { platform, homedir } from 'os'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { getGatewayStatus, restartGateway } from './gateway'
import { checkPort, runDoctorFix } from './troubleshooter'
import { createTerminalLineEmitter } from './terminal-output'
import { buildWslBashArgs, readWslFile, runInWsl, writeWslFile } from './wsl-utils'
import { getPathEnv, resolvePreferredBin } from './path-utils'
import { ensureFeishuPluginCompatible, ensureFeishuSecretProviderReady } from './onboarder'

type RepairActionType =
  | 'doctor_fix'
  | 'disable_memory_search'
  | 'set_gateway_mode_local'
  | 'sync_feishu_plugin'
  | 'trust_lark_plugin'
  | 'disable_feishu_channel'
  | 'restart_gateway'
  | 'run_command'
  | 'none'

type RepairApprovalMode = 'auto' | 'confirm'
type RepairRuntime = 'host' | 'wsl'

interface RepairAction {
  type: RepairActionType
  reason: string
  command?: string
  effect?: string
  runtime?: RepairRuntime
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
  channels?: {
    feishu?: {
      enabled?: boolean
      appId?: unknown
      appSecret?: unknown
      accounts?: Record<string, { appId?: unknown; appSecret?: unknown; enabled?: boolean }>
    }
  }
  plugins?: {
    allow?: string[]
    installs?: Record<string, { version?: string }>
    entries?: {
      feishu?: {
        enabled?: boolean
      }
    }
  }
  secrets?: {
    providers?: Record<string, unknown>
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
  openclawVersion?: string
  feishuPluginVersion?: string
  feishuConfigured: boolean
  feishuEnabled: boolean
  larkPluginTrusted: boolean
  larkSecretProviderConfigured: boolean
  larkSecretRefDetected: boolean
}

export interface AiRepairResult {
  success: boolean
  summary: string
  actions: string[]
  error?: string
  roundsCompleted?: number
  awaitingApproval?: {
    planId: string
    summary: string
    source: 'ai' | 'fallback'
    actions: AiRepairPlanAction[]
  }
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

const MAX_CONTEXT_LOG_LINES = 120
const MAX_ACTIONS = 4
const MAX_AUTO_REPAIR_ROUNDS = 3
const PENDING_PLAN_TTL_MS = 10 * 60 * 1000
const REPAIR_ACTION_LABELS: Record<Exclude<RepairActionType, 'none'>, string> = {
  doctor_fix: '执行 doctor fix',
  disable_memory_search: '关闭语义记忆',
  set_gateway_mode_local: '设置 gateway.mode=local',
  sync_feishu_plugin: '同步飞书插件',
  trust_lark_plugin: '信任飞书插件',
  disable_feishu_channel: '停用飞书渠道',
  restart_gateway: '重启 Gateway',
  run_command: '执行命令'
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
  sync_feishu_plugin: {
    effect: '重新同步飞书插件到与当前 OpenClaw 兼容的版本，修复版本不匹配导致的启动异常。',
    approval: 'auto'
  },
  trust_lark_plugin: {
    effect: '把 openclaw-lark 写入 plugins.allow，避免插件因未显式信任而反复告警或被拦截。',
    approval: 'confirm'
  },
  disable_feishu_channel: {
    effect: '暂时停用异常的飞书渠道配置，先让 Gateway 恢复启动，后续再重新配置飞书。',
    approval: 'confirm'
  },
  restart_gateway: {
    effect: '重新拉起 Gateway，让刚修过的配置立即生效。',
    approval: 'auto'
  },
  run_command: {
    effect: '按用户确认后的命令执行更细粒度的诊断或修复。',
    approval: 'confirm'
  }
}
const pendingRepairPlans = new Map<string, PendingRepairPlan>()
const MAX_COMMAND_LENGTH = 420
const LARK_PLUGIN_ID = 'openclaw-lark'
const LARK_SECRET_PROVIDER = 'lark-secrets'
const FORBIDDEN_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bmkfs\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bRemove-Item\b/i,
  /\brd\s+\/s\b/i,
  /\bdel\s+\/[a-z]*s\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\btaskkill\b.*\/f/i,
  /\bpkill\b\s+-9\b/i
]

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

const getDefaultRuntime = (): RepairRuntime => (platform() === 'win32' ? 'wsl' : 'host')

const trimCommand = (value?: string): string => value?.trim() ?? ''

const parseSemver = (value: string): [number, number, number] | null => {
  const match = value.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compareSemver = (left?: string, right?: string): number | null => {
  if (!left || !right) return null
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

const isSecretRefString = (value: string): boolean =>
  value.trim().startsWith(`file:${LARK_SECRET_PROVIDER}:`)

const isSecretRefObject = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false
  const typed = value as Record<string, unknown>
  return (
    typed.provider === LARK_SECRET_PROVIDER ||
    (typed.source === 'file' && typed.provider === LARK_SECRET_PROVIDER) ||
    (typeof typed.ref === 'string' && isSecretRefString(typed.ref))
  )
}

const isLarkSecretRef = (value: unknown): boolean => {
  if (typeof value === 'string') return isSecretRefString(value)
  return isSecretRefObject(value)
}

const validateCustomCommand = (command: string): { ok: true } | { ok: false; error: string } => {
  if (!command) {
    return { ok: false, error: 'AI 修复计划缺少命令内容。' }
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return { ok: false, error: 'AI 修复命令过长，请拆成更小的步骤。' }
  }

  if (/[\r\n]/.test(command)) {
    return { ok: false, error: 'AI 修复命令必须保持单行，不能包含换行。' }
  }

  if (/(^|[^|])&&|\|\||;/.test(command)) {
    return { ok: false, error: 'AI 修复命令不能包含链式执行符，请拆成多步确认。' }
  }

  if (FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return { ok: false, error: 'AI 修复命令命中了高风险禁用规则，已阻止执行。' }
  }

  return { ok: true }
}

const buildRuntimeHint = (runtime: RepairRuntime): string => {
  if (platform() === 'win32') {
    return runtime === 'host'
      ? 'Windows 下会在宿主 PowerShell 中执行'
      : 'Windows 下会自动在 WSL Ubuntu 中执行'
  }

  return '会在当前系统 Shell 中执行'
}

const buildCommandPreview = async (
  action: RepairAction
): Promise<{ commandPreview: string; commandRuntime: string }> => {
  const scriptMap: Record<Exclude<RepairActionType, 'none'>, string> = {
    doctor_fix: 'openclaw doctor --fix',
    disable_memory_search: 'openclaw config set agents.defaults.memorySearch.enabled false',
    set_gateway_mode_local: 'openclaw config set gateway.mode local',
    sync_feishu_plugin: 'npx -y @larksuite/openclaw-lark-tools@latest install',
    trust_lark_plugin: 'openclaw config set plugins.allow ["openclaw-lark"]',
    disable_feishu_channel: 'openclaw config set channels.feishu.enabled false',
    restart_gateway: 'openclaw gateway restart',
    run_command: trimCommand(action.command)
  }

  const runtime = action.runtime ?? getDefaultRuntime()
  const script = scriptMap[action.type]

  return {
    commandPreview: script,
    commandRuntime: buildRuntimeHint(runtime)
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

const getInstalledOpenClawVersion = async (): Promise<string | undefined> => {
  try {
    if (platform() === 'win32') {
      const raw = await runInWsl('openclaw --version', 10000)
      return raw.match(/v?(\d+\.\d+\.\d+)/)?.[1]
    }

    const openclaw = resolvePreferredBin('openclaw')
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(openclaw, ['--version'], { env: getPathEnv() })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(stderr.trim() || `exit ${code}`))
      })
      child.on('error', reject)
    })
    return raw.match(/v?(\d+\.\d+\.\d+)/)?.[1]
  } catch {
    return undefined
  }
}

const getInstalledLarkPluginVersion = async (
  config: RawOpenClawConfig | null
): Promise<string | undefined> => {
  const configVersion = config?.plugins?.installs?.[LARK_PLUGIN_ID]?.version?.trim()
  if (configVersion) return configVersion

  const packagePath =
    platform() === 'win32'
      ? '/root/.openclaw/extensions/openclaw-lark/package.json'
      : join(homedir(), '.openclaw', 'extensions', 'openclaw-lark', 'package.json')

  try {
    const raw =
      platform() === 'win32' ? await readWslFile(packagePath) : readFileSync(packagePath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version?.trim() || undefined
  } catch {
    return undefined
  }
}

const getFeishuAccountRecords = (
  config: RawOpenClawConfig | null
): Array<Record<string, unknown>> => {
  const feishu = config?.channels?.feishu
  if (!feishu) return []

  const accounts = feishu.accounts
  const nested = accounts ? Object.values(accounts) : []
  return [feishu as Record<string, unknown>, ...nested.filter(Boolean)]
}

const hasBrokenLarkSecretRefs = (config: RawOpenClawConfig | null): boolean => {
  const entries = getFeishuAccountRecords(config)
  return entries.some((entry) => isLarkSecretRef(entry.appId) || isLarkSecretRef(entry.appSecret))
}

const hasFeishuConfig = (config: RawOpenClawConfig | null): boolean => {
  const feishu = config?.channels?.feishu
  if (!feishu) return false
  if (feishu.enabled) return true
  if (typeof feishu.appId === 'string' || typeof feishu.appSecret === 'string') return true
  return Boolean(feishu.accounts && Object.keys(feishu.accounts).length > 0)
}

const getRepairLogText = (context: RepairContext): string => context.recentLogs.join('\n').toLowerCase()

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
  const openclawVersion = await getInstalledOpenClawVersion()
  const feishuPluginVersion = await getInstalledLarkPluginVersion(config)
  const recentLogFileLines = await readRecentGatewayLogLines()
  const recentLogs = [...normalizeRecentLogs(request.logs), ...recentLogFileLines].slice(
    -MAX_CONTEXT_LOG_LINES
  )
  const feishuConfigured = hasFeishuConfig(config)
  const feishuEnabled = config?.channels?.feishu?.enabled === true
  const larkPluginTrusted = config?.plugins?.allow?.includes(LARK_PLUGIN_ID) ?? false
  const larkSecretProviderConfigured = Boolean(config?.secrets?.providers?.[LARK_SECRET_PROVIDER])
  const larkSecretRefDetected = hasBrokenLarkSecretRefs(config)

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
    recentLogs,
    openclawVersion,
    feishuPluginVersion,
    feishuConfigured,
    feishuEnabled,
    larkPluginTrusted,
    larkSecretProviderConfigured,
    larkSecretRefDetected
  }
}

const parsePlanFromText = (rawText: string): RepairPlan | null => {
  const start = rawText.indexOf('{')
  const end = rawText.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(rawText.slice(start, end + 1)) as {
      summary?: string
      actions?: Array<{
        type?: string
        reason?: string
        command?: string
        effect?: string
        runtime?: string
      }>
    }

    const actions: RepairAction[] = []

    for (const item of parsed.actions ?? []) {
      if (actions.length >= MAX_ACTIONS) break

      const type = item.type as RepairActionType | undefined
      if (
        type !== 'doctor_fix' &&
        type !== 'disable_memory_search' &&
        type !== 'set_gateway_mode_local' &&
        type !== 'sync_feishu_plugin' &&
        type !== 'trust_lark_plugin' &&
        type !== 'disable_feishu_channel' &&
        type !== 'restart_gateway' &&
        type !== 'run_command' &&
        type !== 'none'
      ) {
        continue
      }

      if (type === 'run_command') {
        const command = trimCommand(item.command)
        const validation = validateCustomCommand(command)
        if (!validation.ok) {
          continue
        }

        const runtime =
          item.runtime === 'host' || item.runtime === 'wsl'
            ? item.runtime
            : getDefaultRuntime()

        actions.push({
          type,
          reason: item.reason?.trim() || '模型建议执行该命令。',
          command,
          effect: item.effect?.trim() || '执行一条额外命令来完成诊断或修复。',
          runtime
        })
        continue
      }

      actions.push({
        type,
        reason: item.reason?.trim() || '模型建议执行该动作'
      })
    }

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
  const recentLogText = getRepairLogText(context)
  const pluginVersionCompare = compareSemver(context.feishuPluginVersion, context.openclawVersion)

  if (
    context.feishuConfigured &&
    (pluginVersionCompare === -1 ||
      /secretproviderresolutionerror|lark-secrets|required secrets are unavailable/.test(
        recentLogText
      ))
  ) {
    actions.push({
      type: 'sync_feishu_plugin',
      reason:
        pluginVersionCompare === -1
          ? `飞书插件版本 ${context.feishuPluginVersion ?? 'unknown'} 落后于 OpenClaw ${context.openclawVersion ?? 'unknown'}。`
          : '日志显示飞书插件或其 secret provider 解析异常，先同步插件版本。'
    })
  }

  if (
    context.feishuConfigured &&
    /plugins\.allow is empty|loaded without install\/load-path provenance|pin trust via plugins\.allow/.test(
      recentLogText
    ) &&
    !context.larkPluginTrusted
  ) {
    actions.push({
      type: 'trust_lark_plugin',
      reason: '日志显示 openclaw-lark 未被显式信任，可能导致插件运行异常。'
    })
  }

  if (
    context.feishuConfigured &&
    context.larkSecretRefDetected &&
    !context.larkSecretProviderConfigured &&
    /lark-secrets|required secrets are unavailable|secretproviderresolutionerror/.test(recentLogText)
  ) {
    actions.push({
      type: 'disable_feishu_channel',
      reason: '飞书渠道引用了未配置的 lark-secrets，当前会直接阻塞 Gateway 启动。'
    })
  }

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
    if (
      !/lark-secrets|required secrets are unavailable|secretproviderresolutionerror/.test(
        recentLogText
      )
    ) {
      actions.push({
        type: 'doctor_fix',
        reason: 'Gateway 当前未运行，先执行 doctor fix。'
      })
    }
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

const fingerprintRepairAction = (action: RepairAction): string => {
  return [action.type, trimCommand(action.command), action.runtime ?? ''].join('|')
}

const fingerprintRepairPlan = (actions: RepairAction[]): string => {
  return actions.map((action) => fingerprintRepairAction(action)).join('||')
}

const describeRepairAction = async (action: RepairAction): Promise<AiRepairPlanAction | null> => {
  if (action.type === 'none') return null
  const meta = REPAIR_ACTION_META[action.type]
  const { commandPreview, commandRuntime } = await buildCommandPreview(action)

  return {
    type: action.type,
    label:
      action.type === 'run_command' && action.command
        ? `执行命令：${action.command}`
        : REPAIR_ACTION_LABELS[action.type],
    reason: action.reason,
    effect: action.effect?.trim() || meta.effect,
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
    portInUse: context.portInUse,
    openclawVersion: context.openclawVersion,
    feishuPluginVersion: context.feishuPluginVersion,
    feishuConfigured: context.feishuConfigured,
    feishuEnabled: context.feishuEnabled,
    larkPluginTrusted: context.larkPluginTrusted,
    larkSecretProviderConfigured: context.larkSecretProviderConfigured,
    larkSecretRefDetected: context.larkSecretRefDetected
  }

  return [
    '你是 OpenClaw Windows 安装器内置的故障修复规划器。',
    '请只根据给定上下文，返回一个 JSON 对象，不要输出 markdown，不要解释。',
    '你只能从以下动作里选择，且最多返回 4 个动作：',
    'doctor_fix, disable_memory_search, set_gateway_mode_local, sync_feishu_plugin, trust_lark_plugin, disable_feishu_channel, restart_gateway, run_command, none。',
    '只有当现有动作不够表达修复方案时，才使用 run_command。',
    'run_command 必须包含 command、effect、runtime 字段，其中 runtime 只能是 wsl 或 host。',
    '在 Windows 上，只要命令和 OpenClaw、WSL 内配置、插件、日志相关，优先使用 runtime="wsl"。',
    'run_command 的 command 必须是一条可复制执行的单行命令，不要包含 &&、||、; 或换行。',
    '不要输出删除系统文件、关机重启系统、磁盘格式化、git reset、强制杀进程等危险命令。',
    '如果 Gateway 实际已经在运行，不要误判成失败。',
    '如果日志里出现 memorySearch / embedding provider 未就绪，优先 disable_memory_search。',
    '如果 gateway.mode 不是 local，优先 set_gateway_mode_local。',
    '如果飞书插件版本落后于 OpenClaw，或日志显示飞书插件不兼容，优先 sync_feishu_plugin。',
    '如果日志显示 plugins.allow is empty 且 openclaw-lark 未受信任，可使用 trust_lark_plugin。',
    '如果日志显示 lark-secrets 未配置且当前飞书渠道阻塞启动，可使用 disable_feishu_channel。',
    '如果无法确定，给出最保守的动作组合。',
    '返回格式：{"summary":"...","actions":[{"type":"restart_gateway","reason":"..."}]}',
    'run_command 示例：{"type":"run_command","reason":"需要补插件信任配置","command":"openclaw config set plugins.allow [\\"openclaw-lark\\"]","effect":"把插件加入显式信任列表","runtime":"wsl"}',
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

const trustLarkPlugin = async (): Promise<boolean> => {
  const { changed } = await updateConfig((config) => {
    config.plugins = config.plugins ?? {}
    const currentAllow = Array.isArray(config.plugins.allow) ? config.plugins.allow : []
    if (currentAllow.includes(LARK_PLUGIN_ID)) return false
    config.plugins.allow = [...currentAllow, LARK_PLUGIN_ID]
    return true
  })
  return changed
}

const disableFeishuChannel = async (): Promise<boolean> => {
  const { changed } = await updateConfig((config) => {
    let changedLocal = false

    config.channels = config.channels ?? {}
    config.plugins = config.plugins ?? {}
    config.plugins.entries = config.plugins.entries ?? {}
    config.plugins.entries.feishu = config.plugins.entries.feishu ?? {}

    if (!config.channels.feishu) {
      config.channels.feishu = {}
    }

    const currentFeishu = config.channels.feishu
    if (currentFeishu.enabled !== false) {
      currentFeishu.enabled = false
      changedLocal = true
    }

    if (currentFeishu.appId !== undefined) {
      delete currentFeishu.appId
      changedLocal = true
    }

    if (currentFeishu.appSecret !== undefined) {
      delete currentFeishu.appSecret
      changedLocal = true
    }

    if (currentFeishu.accounts) {
      for (const account of Object.values(currentFeishu.accounts)) {
        if (account.appId !== undefined) {
          delete account.appId
          changedLocal = true
        }
        if (account.appSecret !== undefined) {
          delete account.appSecret
          changedLocal = true
        }
        if (account.enabled !== false) {
          account.enabled = false
          changedLocal = true
        }
      }
    }

    if (config.plugins?.entries?.feishu?.enabled !== false) {
      config.plugins.entries.feishu.enabled = false
      changedLocal = true
    }

    return changedLocal
  })
  return changed
}

const inferCommandSideEffects = (
  command: string
): { changedConfig: boolean; restarted: boolean } => {
  const normalized = command.toLowerCase()
  return {
    changedConfig:
      /\bopenclaw\s+config\s+set\b/.test(normalized) ||
      normalized.includes('openclaw.json') ||
      normalized.includes('auth-profiles.json') ||
      normalized.includes('plugins.allow'),
    restarted:
      /\bopenclaw\s+gateway\s+(restart|start)\b/.test(normalized) ||
      /\bgateway\s+restart\b/.test(normalized)
  }
}

const executeCustomCommand = async (
  win: BrowserWindow,
  action: RepairAction
): Promise<{ changedConfig: boolean; restarted: boolean }> => {
  const command = trimCommand(action.command)
  const validation = validateCustomCommand(command)
  if (!validation.ok) {
    throw new Error(validation.error)
  }

  const runtime = action.runtime ?? getDefaultRuntime()
  const isWindows = platform() === 'win32'
  const cmd =
    runtime === 'wsl' && isWindows
      ? 'wsl'
      : isWindows
        ? 'powershell'
        : process.env.SHELL || '/bin/bash'
  const args =
    runtime === 'wsl' && isWindows
      ? await buildWslBashArgs(command)
      : isWindows
        ? ['-NoProfile', '-Command', command]
        : ['-lc', command]
  const env = runtime === 'wsl' && isWindows ? process.env : getPathEnv()
  const stdoutEmitter = await createTerminalLineEmitter((msg) => emitProgress(win, msg))
  const stderrEmitter = await createTerminalLineEmitter((msg) => emitProgress(win, msg))

  emitProgress(win, `[AI修复] 正在执行命令：${command}`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      shell: false
    })

    child.stdout.on('data', (chunk: Buffer) => stdoutEmitter.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrEmitter.push(chunk))
    child.on('close', (code) => {
      stdoutEmitter.flush()
      stderrEmitter.flush()
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`命令执行失败（exit ${code}）`))
    })
    child.on('error', (error) => {
      stdoutEmitter.flush()
      stderrEmitter.flush()
      reject(error)
    })
  })

  const sideEffects = inferCommandSideEffects(command)
  return sideEffects
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
    case 'sync_feishu_plugin': {
      emitProgress(win, `[AI修复] 正在同步飞书插件：${action.reason}`)
      const changedConfig = await ensureFeishuPluginCompatible((msg) => emitProgress(win, msg))
      emitProgress(
        win,
        changedConfig
          ? '[AI修复] 飞书插件同步完成。'
          : '[AI修复] 飞书插件已经是兼容版本，未执行额外同步。'
      )
      return { changedConfig, restarted: false }
    }
    case 'trust_lark_plugin': {
      emitProgress(win, `[AI修复] 正在补充飞书插件信任：${action.reason}`)
      const changedConfig = await trustLarkPlugin()
      emitProgress(
        win,
        changedConfig
          ? '[AI修复] 已将 openclaw-lark 加入 plugins.allow。'
          : '[AI修复] openclaw-lark 已经在 plugins.allow 中。'
      )
      return { changedConfig, restarted: false }
    }
    case 'disable_feishu_channel': {
      emitProgress(win, `[AI修复] 正在停用异常飞书渠道：${action.reason}`)
      const autoDisabledByProvider = await ensureFeishuSecretProviderReady((msg) =>
        emitProgress(win, msg)
      )
      const changedConfig = autoDisabledByProvider || (await disableFeishuChannel())
      emitProgress(
        win,
        changedConfig
          ? '[AI修复] 已停用当前异常的飞书渠道配置。'
          : '[AI修复] 飞书渠道已处于停用状态。'
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
    case 'run_command':
      emitProgress(win, `[AI修复] 正在执行确认后的命令：${action.reason}`)
      return executeCustomCommand(win, action)
  }
}

const buildPlanForContext = async (
  context: RepairContext
): Promise<{ plan: RepairPlan; mode: 'ai' | 'fallback' }> => {
  try {
    return {
      plan: await planWithModel(context),
      mode: 'ai'
    }
  } catch (error) {
    return {
      plan: buildFallbackPlan(context, error instanceof Error ? error.message : '模型分析失败'),
      mode: 'fallback'
    }
  }
}

export const planAiRepair = async (
  win: BrowserWindow,
  request: AiRepairRequest = {}
): Promise<AiRepairPlanResult> => {
  emitProgress(win, '[AI修复] 正在读取当前配置、状态和最近日志...')
  const initialContext = await readRepairContext(request)

  emitProgress(
    win,
    initialContext.apiKey && initialContext.provider
      ? `[AI修复] 正在调用 ${initialContext.provider}/${stripNamespace(initialContext.modelId)} 分析问题...`
      : '[AI修复] 当前没有可直接调用的模型凭据，改用保守修复流程。'
  )
  const { plan } = await buildPlanForContext(initialContext)

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
  const executedLabels: string[] = []
  const seenPlanFingerprints = new Set<string>()
  let currentPlan: RepairPlan = {
    summary: pendingPlan.summary,
    actions: pendingPlan.actions,
    source: pendingPlan.source
  }
  let roundsCompleted = 0

  while (roundsCompleted < MAX_AUTO_REPAIR_ROUNDS) {
    const actionsToRun = currentPlan.actions.filter((action) => action.type !== 'none')

    if (actionsToRun.length === 0) {
      const finalStatus = await getGatewayStatus()
      if (finalStatus === 'running') {
        emitProgress(win, '[AI修复] 当前没有额外修复动作，Gateway 保持运行中。')
        return {
          success: true,
          summary: executedLabels.length
            ? `${currentPlan.summary} 已执行：${executedLabels.join('、')}。`
            : currentPlan.summary,
          actions: executedLabels,
          roundsCompleted
        }
      }

      emitError(win, 'AI 修复没有生成新的动作，但 Gateway 仍未恢复运行。')
      return {
        success: false,
        summary: currentPlan.summary,
        actions: executedLabels,
        error: '当前没有新的修复动作可执行',
        roundsCompleted
      }
    }

    const currentFingerprint = fingerprintRepairPlan(actionsToRun)
    if (seenPlanFingerprints.has(currentFingerprint)) {
      emitError(win, 'AI 修复计划开始重复，已停止自动重试。')
      return {
        success: false,
        summary: currentPlan.summary,
        actions: executedLabels,
        error: '修复计划开始重复，已停止自动重试',
        roundsCompleted
      }
    }
    seenPlanFingerprints.add(currentFingerprint)

    let changedConfigInRound = false
    let restartedInRound = false

    emitProgress(win, `[AI修复] 开始执行第 ${roundsCompleted + 1} 轮修复...`)

    for (const action of actionsToRun) {
      const result = await executeRepairAction(win, action)
      if (action.type !== 'none') {
        executedLabels.push(
          action.type === 'run_command' && action.command
            ? `执行命令(${action.command})`
            : REPAIR_ACTION_LABELS[action.type]
        )
      }
      changedConfigInRound = changedConfigInRound || result.changedConfig
      restartedInRound = restartedInRound || result.restarted
    }

    if (changedConfigInRound && !restartedInRound) {
      emitProgress(win, '[AI修复] 本轮配置已更新，补充执行一次 Gateway 重启...')
      const restartResult = await restartGateway()
      if (restartResult.status !== 'started') {
        throw new Error(restartResult.error || '配置更新后重启 Gateway 失败')
      }
      executedLabels.push(REPAIR_ACTION_LABELS.restart_gateway)
      restartedInRound = true
    }

    roundsCompleted += 1

    if (roundsCompleted >= MAX_AUTO_REPAIR_ROUNDS) {
      break
    }

    emitProgress(win, `[AI修复] 第 ${roundsCompleted} 轮执行完成，正在重新分析当前状态...`)
    const nextContext = await readRepairContext()
    const { plan: nextPlan } = await buildPlanForContext(nextContext)
    const nextActions = resolveRepairActions(nextPlan, nextContext)

    if (nextActions.length === 0) {
      const finalStatus = await getGatewayStatus()
      const summary = executedLabels.length
        ? `${nextPlan.summary} 已执行：${executedLabels.join('、')}。`
        : nextPlan.summary

      if (finalStatus === 'running') {
        emitProgress(win, '[AI修复] Gateway 当前已恢复运行。')
        return {
          success: true,
          summary,
          actions: executedLabels,
          roundsCompleted
        }
      }

      emitError(win, 'AI 修复已执行，但 Gateway 仍未恢复运行。')
      return {
        success: false,
        summary,
        actions: executedLabels,
        error: 'Gateway 仍未恢复运行',
        roundsCompleted
      }
    }

    const { planId, requiresApproval, describedActions } = await registerPendingPlan(nextPlan, nextActions)
    if (requiresApproval) {
      emitProgress(win, `[AI修复] 第 ${roundsCompleted + 1} 轮包含高影响动作，等待你确认后继续。`)
      return {
        success: false,
        summary: executedLabels.length
          ? `${currentPlan.summary} 已执行：${executedLabels.join('、')}。`
          : currentPlan.summary,
        actions: executedLabels,
        roundsCompleted,
        awaitingApproval: {
          planId,
          summary: nextPlan.summary,
          source: nextPlan.source,
          actions: describedActions
        }
      }
    }

    emitProgress(win, `[AI修复] 第 ${roundsCompleted + 1} 轮只包含低影响动作，继续自动修复。`)
    currentPlan = {
      summary: nextPlan.summary,
      actions: nextActions,
      source: nextPlan.source
    }
  }

  const finalGatewayStatus = await getGatewayStatus()
  const summary = executedLabels.length
    ? `${currentPlan.summary} 已执行：${executedLabels.join('、')}。`
    : currentPlan.summary

  if (finalGatewayStatus === 'running') {
    emitProgress(win, '[AI修复] 已达到本次自动修复轮数上限，Gateway 当前保持运行。')
    return {
      success: true,
      summary,
      actions: executedLabels,
      roundsCompleted
    }
  }

  emitError(win, '已达到本次自动修复轮数上限，Gateway 仍未恢复运行。')
  return {
    success: false,
    summary,
    actions: executedLabels,
    error: '已达到本次自动修复轮数上限',
    roundsCompleted
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
