import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { platform, homedir, tmpdir } from 'os'
import { join } from 'path'
import https from 'https'
import { BrowserWindow } from 'electron'
import { runInWsl, readWslFile, writeWslFile, buildWslBashArgs } from './wsl-utils'
import { getManagedNpmEnv } from './npm-paths'
import { createTerminalLineEmitter } from './terminal-output'
import { t } from '../../shared/i18n/main'
import type {
  CurrentMemorySearchConfig,
  MemorySearchConfigPayload,
  MemorySearchProvider
} from '../../shared/types/memory-search'

interface OnboardConfig {
  provider:
    | 'modelfamily'
    | 'anthropic'
    | 'google'
    | 'openai'
    | 'minimax'
    | 'glm'
    | 'deepseek'
    | 'ollama'
  apiKey?: string
  authMethod?: 'api-key' | 'oauth'
  channelType?: 'feishu' | 'wechat' | 'telegram'
  channelSetupMode?: 'one-click' | 'manual'
  telegramBotToken?: string
  feishuAppId?: string
  feishuAppSecret?: string
  modelId?: string
  memorySearch?: MemorySearchConfigPayload
}

interface OnboardResult {
  botUsername?: string
}

export interface ProviderKeyValidationResult {
  success: boolean
  error?: string
  warning?: string
}

const PROVIDER_KEY_VALIDATION_TIMEOUT_MS = 15000

const LOG_BATCH_INTERVAL_MS = 120
const LOG_MAX_BATCH_LINES = 24
const LOG_MAX_LINE_LENGTH = 600
const createInstallProgressEmitter = (
  win: BrowserWindow
): {
  log: (msg: string) => void
  status: (percent: number, stage: string, detail?: string) => void
  dispose: () => void
} => {
  let disposed = false
  let timer: NodeJS.Timeout | null = null
  let queue: string[] = []

  const sanitizeLine = (msg: string): string => {
    const singleLine = msg.replace(/\r/g, '').replace(/\u0000/g, '')
    return singleLine.length > LOG_MAX_LINE_LENGTH
      ? `${singleLine.slice(0, LOG_MAX_LINE_LENGTH)} ...[truncated]`
      : singleLine
  }

  const flush = (): void => {
    if (disposed || queue.length === 0) {
      timer = null
      return
    }

    const batch = queue.slice(0, LOG_MAX_BATCH_LINES)
    queue = queue.slice(LOG_MAX_BATCH_LINES)

    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        disposed = true
        queue = []
        timer = null
        return
      }
      win.webContents.send('install:progress', batch.join('\n'))
    } catch {
      disposed = true
      queue = []
      timer = null
      return
    }

    if (queue.length > 0) {
      timer = setTimeout(flush, LOG_BATCH_INTERVAL_MS)
    } else {
      timer = null
    }
  }

  const schedule = (): void => {
    if (disposed || timer) return
    timer = setTimeout(flush, LOG_BATCH_INTERVAL_MS)
  }

  return {
    log: (msg: string): void => {
      if (disposed) return

      const lines = msg.split('\n').map(sanitizeLine)
      queue.push(...lines)

      if (queue.length > 200) {
        const dropped = queue.length - 200
        queue = [`...[omitted ${dropped} log lines]`, ...queue.slice(-199)]
      }

      schedule()
    },
    status: (percent: number, stage: string, detail?: string): void => {
      if (disposed) return

      try {
        if (win.isDestroyed() || win.webContents.isDestroyed()) {
          disposed = true
          queue = []
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          return
        }
        win.webContents.send('install:status', {
          percent: Math.max(0, Math.min(100, Math.round(percent))),
          stage,
          detail
        })
      } catch {
        disposed = true
        queue = []
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
    },
    dispose: (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      flush()
      disposed = true
      queue = []
    }
  }
}

const getChannelPatch = (
  config: OnboardConfig
): { key: string; value: Record<string, unknown> } | null => {
  if (config.channelType === 'telegram' && config.telegramBotToken) {
    return {
      key: 'telegram',
      value: {
        enabled: true,
        botToken: config.telegramBotToken,
        dmPolicy: 'open',
        allowFrom: ['*'],
        groups: { '*': { requireMention: true } }
      }
    }
  }

  if (config.channelType === 'feishu' && config.feishuAppId && config.feishuAppSecret) {
    return {
      key: 'feishu',
      value: {
        enabled: true,
        dmPolicy: 'pairing',
        accounts: {
          main: {
            appId: config.feishuAppId,
            appSecret: config.feishuAppSecret,
            name: 'EasyClaw'
          }
        }
      }
    }
  }

  return null
}

const getActiveChannelType = (
  channels?: Record<string, unknown>
): 'feishu' | 'wechat' | 'telegram' | undefined => {
  if (!channels) return undefined
  if ((channels.telegram as { botToken?: string } | undefined)?.botToken) return 'telegram'
  if ((channels.feishu as { enabled?: boolean } | undefined)?.enabled) return 'feishu'
  if ((channels.wechat as { enabled?: boolean } | undefined)?.enabled) return 'wechat'
  return undefined
}

const telegramGet = (url: string): Promise<{ ok: boolean; [k: string]: unknown }> =>
  new Promise((resolve) => {
    https
      .get(url, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve({ ok: false })
          }
        })
      })
      .on('error', () => resolve({ ok: false }))
  })

const fetchBotUsername = async (token: string): Promise<string | undefined> => {
  const json = await telegramGet(`https://api.telegram.org/bot${token}/getMe`)
  return json.ok ? (json as unknown as { result: { username: string } }).result.username : undefined
}

const waitTelegramClear = async (token: string): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    const res = await telegramGet(
      `https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=1`
    )
    if (res.ok) return
    await new Promise((r) => setTimeout(r, 3000))
  }
}

import { getPathEnv, resolvePreferredBin } from './path-utils'

const OAUTH_PROFILE_ID = 'openai-codex:default'

const DEFAULT_MODELS: Record<string, string> = {
  modelfamily: 'modelfamily/claude-opus-4-6',
  anthropic: 'anthropic/claude-sonnet-4-6',
  google: 'google/gemini-3-flash',
  openai: 'openai/gpt-5.4',
  'openai-codex': 'openai-codex/gpt-5.4',
  minimax: 'minimax/MiniMax-M2.7',
  glm: 'zai/glm-5',
  deepseek: 'deepseek/deepseek-chat',
  ollama: 'ollama/llama3.3'
}

const MODEL_SPECS: Partial<
  Record<OnboardConfig['provider'], { contextWindow: number; maxTokens: number }>
> = {
  minimax: { contextWindow: 1000000, maxTokens: 16384 }
}

const MEMORY_SEARCH_PROVIDER_CONFIG_PATH: Record<MemorySearchProvider, 'openai' | 'google'> = {
  openai: 'openai',
  gemini: 'google'
}

const MEMORY_SEARCH_PROVIDER_LABEL: Record<MemorySearchProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini'
}

const MEMORY_SEARCH_DEFAULT_MODELS: Record<MemorySearchProvider, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001'
}

const createRunCmd = (): ((
  cmd: string,
  args: string[],
  onLog: (msg: string) => void
) => Promise<void>) => {
  const isWindows = platform() === 'win32'
  return async (cmd, args, onLog) => {
    const stdoutEmitter = await createTerminalLineEmitter(onLog)
    const stderrEmitter = await createTerminalLineEmitter(onLog)
    let fullCmd: string
    let fullArgs: string[]

    if (isWindows) {
      // WSL mode: wsl -d Ubuntu -u root -- bash -lc "cmd args..."
      const script = `${cmd} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`
      fullCmd = 'wsl'
      fullArgs = await buildWslBashArgs(script)
    } else {
      fullCmd = cmd
      fullArgs = args
    }

    return new Promise((resolve, reject) => {
      const child = spawn(fullCmd, fullArgs, {
        env: isWindows ? process.env : getManagedNpmEnv(getPathEnv())
      })

      child.stdout.on('data', (d: Buffer) => stdoutEmitter.push(d))
      child.stderr.on('data', (d: Buffer) => stderrEmitter.push(d))
      child.on('close', (code) => {
        stdoutEmitter.flush()
        stderrEmitter.flush()
        if (code === 0) resolve()
        else reject(new Error(`Command failed with exit code ${code}`))
      })
      child.on('error', (error) => {
        stdoutEmitter.flush()
        stderrEmitter.flush()
        reject(error)
      })
    })
  }
}

const getConfigPath = (): string => join(homedir(), '.openclaw', 'openclaw.json')

const LARK_SECRET_PROVIDER = 'lark-secrets'
const LARK_PLUGIN_ID = 'openclaw-lark'
const LARK_PLUGIN_PACKAGE = '@larksuite/openclaw-lark-tools@latest'

const readOpenClawConfig = async (): Promise<Record<string, unknown> | null> => {
  if (platform() === 'win32') {
    try {
      return JSON.parse(await readWslFile('/root/.openclaw/openclaw.json'))
    } catch {
      return null
    }
  }

  const configPath = getConfigPath()
  if (!existsSync(configPath)) return null
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

const writeOpenClawConfig = async (config: Record<string, unknown>): Promise<void> => {
  const serialized = JSON.stringify(config, null, 2)

  if (platform() === 'win32') {
    await writeWslFile('/root/.openclaw/openclaw.json', serialized)
    return
  }

  writeFileSync(getConfigPath(), serialized, { mode: 0o600 })
}

const parseSemanticVersion = (raw: string): [number, number, number] | null => {
  const match = raw.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compareSemanticVersions = (a: string, b: string): number => {
  const parsedA = parseSemanticVersion(a)
  const parsedB = parseSemanticVersion(b)
  if (!parsedA || !parsedB) {
    return a === b ? 0 : a.localeCompare(b)
  }

  for (let i = 0; i < 3; i += 1) {
    if (parsedA[i] !== parsedB[i]) return parsedA[i] > parsedB[i] ? 1 : -1
  }
  return 0
}

const runSimpleCommand = async (
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || `exit code ${code}`))
    })
    child.on('error', reject)
  })

const getInstalledOpenClawVersion = async (): Promise<string | null> => {
  if (platform() === 'win32') {
    try {
      const raw = await runInWsl('openclaw --version', 10000)
      const parsed = parseSemanticVersion(raw)
      return parsed ? raw.match(/v?\d+\.\d+\.\d+/)?.[0]?.replace(/^v/, '') ?? null : null
    } catch {
      return null
    }
  }

  try {
    const raw = await runSimpleCommand(resolvePreferredBin('openclaw'), ['--version'], getPathEnv())
    const parsed = raw.match(/v?(\d+\.\d+\.\d+)/)
    return parsed ? parsed[1] : null
  } catch {
    return null
  }
}

const getInstalledLarkPluginVersion = async (
  config: Record<string, unknown>
): Promise<string | null> => {
  const typed = config as Record<string, unknown>
  const pluginVersion = (
    typed.plugins as Record<string, unknown> | undefined
  )?.installs as Record<string, unknown> | undefined
  const installEntry = pluginVersion?.[LARK_PLUGIN_ID] as Record<string, unknown> | undefined
  if (typeof installEntry?.version === 'string' && installEntry.version.trim()) {
    return installEntry.version.trim()
  }

  const packagePath =
    platform() === 'win32'
      ? '/root/.openclaw/extensions/openclaw-lark/package.json'
      : join(homedir(), '.openclaw', 'extensions', 'openclaw-lark', 'package.json')

  try {
    const raw =
      platform() === 'win32' ? await readWslFile(packagePath) : readFileSync(packagePath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null
  } catch {
    return null
  }
}

const hasFeishuPluginConfig = (config: Record<string, unknown>): boolean => {
  const typed = config as Record<string, unknown>
  const channels =
    typed.channels && typeof typed.channels === 'object'
      ? (typed.channels as Record<string, unknown>)
      : undefined
  const feishu =
    channels?.feishu && typeof channels.feishu === 'object'
      ? (channels.feishu as Record<string, unknown>)
      : undefined
  const pluginEntries =
    typed.plugins && typeof typed.plugins === 'object'
      ? ((typed.plugins as Record<string, unknown>).entries as Record<string, unknown> | undefined)
      : undefined
  const pluginInstalls =
    typed.plugins && typeof typed.plugins === 'object'
      ? ((typed.plugins as Record<string, unknown>).installs as Record<string, unknown> | undefined)
      : undefined

  return Boolean(
    pluginInstalls?.[LARK_PLUGIN_ID] ||
      (pluginEntries?.feishu &&
        typeof pluginEntries.feishu === 'object' &&
        (pluginEntries.feishu as Record<string, unknown>).enabled === true) ||
      (feishu &&
        ((feishu.enabled === true) ||
          typeof feishu.appId === 'string' ||
          typeof feishu.appSecret === 'string' ||
          (feishu.accounts && typeof feishu.accounts === 'object')))
  )
}

export const ensureFeishuPluginCompatible = async (
  onLog?: (msg: string) => void
): Promise<boolean> => {
  const config = await readOpenClawConfig()
  if (!config || !hasFeishuPluginConfig(config)) return false

  const openclawVersion = await getInstalledOpenClawVersion()
  if (!openclawVersion) return false

  const pluginVersion = await getInstalledLarkPluginVersion(config)
  if (pluginVersion && compareSemanticVersions(pluginVersion, openclawVersion) >= 0) {
    return false
  }

  await ensureCommandAvailable('npm')
  await ensureCommandAvailable('npx')

  onLog?.(
    t('onboarder.feishuPluginSyncing', {
      openclawVersion,
      pluginVersion: pluginVersion ?? 'unknown'
    })
  )

  try {
    const runCmd = createRunCmd()
    await runChannelCommand(
      runCmd,
      onLog ?? (() => {}),
      platform() === 'win32' ? 'npx' : resolvePreferredBin('npx'),
      ['-y', LARK_PLUGIN_PACKAGE, 'install']
    )
    onLog?.(t('onboarder.feishuPluginSynced', { openclawVersion }))
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onLog?.(t('onboarder.feishuPluginSyncFailed', { message }))
    return false
  }
}

const isLarkSecretRefString = (value: string): boolean =>
  value.trim().startsWith(`file:${LARK_SECRET_PROVIDER}:`)

const isLarkSecretRefObject = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false

  const typed = value as Record<string, unknown>
  return (
    typed.provider === LARK_SECRET_PROVIDER ||
    (typed.source === 'file' && typed.provider === LARK_SECRET_PROVIDER) ||
    (typeof typed.ref === 'string' && isLarkSecretRefString(typed.ref))
  )
}

const isLarkSecretRef = (value: unknown): boolean => {
  if (typeof value === 'string') return isLarkSecretRefString(value)
  return isLarkSecretRefObject(value)
}

const stripBrokenFeishuCredentials = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false

  const target = value as Record<string, unknown>
  if (!isLarkSecretRef(target.appId) && !isLarkSecretRef(target.appSecret)) {
    return false
  }

  delete target.appId
  delete target.appSecret
  return true
}

export const ensureFeishuSecretProviderReady = async (
  onLog?: (msg: string) => void
): Promise<boolean> => {
  const cfg = await readOpenClawConfig()
  if (!cfg) return false

  const typed = cfg as Record<string, unknown>
  const channels =
    typed.channels && typeof typed.channels === 'object'
      ? (typed.channels as Record<string, unknown>)
      : null
  const feishu =
    channels?.feishu && typeof channels.feishu === 'object'
      ? (channels.feishu as Record<string, unknown>)
      : null

  if (!feishu) return false

  const secrets =
    typed.secrets && typeof typed.secrets === 'object'
      ? (typed.secrets as Record<string, unknown>)
      : null
  const providers =
    secrets?.providers && typeof secrets.providers === 'object'
      ? (secrets.providers as Record<string, unknown>)
      : null

  if (providers?.[LARK_SECRET_PROVIDER]) {
    return false
  }

  let changed = stripBrokenFeishuCredentials(feishu)
  const accounts =
    feishu.accounts && typeof feishu.accounts === 'object'
      ? (feishu.accounts as Record<string, unknown>)
      : null

  if (accounts) {
    for (const account of Object.values(accounts)) {
      changed = stripBrokenFeishuCredentials(account) || changed
    }
  }

  if (!changed) return false

  feishu.enabled = false
  await writeOpenClawConfig(cfg)
  onLog?.(t('onboarder.feishuSecretProviderMissingDisabled'))
  return true
}

const shouldForceDisableOptionalMemorySearch = (memorySearch: unknown): boolean => {
  if (!memorySearch || typeof memorySearch !== 'object') return true

  const config = memorySearch as Record<string, unknown>
  if (typeof config.enabled === 'boolean') return false

  return Object.keys(config).every((key) => key === 'enabled')
}

export const ensureOptionalMemorySearchDisabled = async (
  onLog?: (msg: string) => void
): Promise<boolean> => {
  const cfg = await readOpenClawConfig()
  if (!cfg) return false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typed = cfg as any
  typed.agents = typed.agents ?? {}
  typed.agents.defaults = typed.agents.defaults ?? {}

  if (!shouldForceDisableOptionalMemorySearch(typed.agents.defaults.memorySearch)) {
    return false
  }

  typed.agents.defaults.memorySearch = {
    ...(typed.agents.defaults.memorySearch ?? {}),
    enabled: false
  }
  await writeOpenClawConfig(cfg)
  onLog?.(t('onboarder.memorySearch.migratedDisabled'))
  return true
}

const hasOpenClawConfig = async (): Promise<boolean> => {
  if (platform() === 'win32') {
    try {
      await readWslFile('/root/.openclaw/openclaw.json')
      return true
    } catch {
      return false
    }
  }

  return existsSync(getConfigPath())
}

const ensureCommandAvailable = async (commandName: 'npm' | 'npx'): Promise<void> => {
  if (platform() === 'win32') {
    try {
      await runInWsl(`command -v ${commandName} >/dev/null 2>&1`, 10000)
      return
    } catch {
      throw new Error(t('onboarder.npxRequired'))
    }
  }

  const resolved = resolvePreferredBin(commandName)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(resolved, ['--version'], {
        env: getManagedNpmEnv(getPathEnv())
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(String(code)))
      })
      child.on('error', reject)
    })
  } catch {
    throw new Error(t('onboarder.npxRequired'))
  }
}

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const waitForStatusFile = async (statusPath: string, timeoutMs = 30 * 60 * 1000): Promise<number> => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(statusPath)) {
      const raw = readFileSync(statusPath, 'utf-8').trim()
      const code = Number(raw)
      return Number.isFinite(code) ? code : 1
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error('Timed out waiting for interactive terminal command to finish')
}

const runMacTerminalScript = async (
  title: string,
  commands: string[],
  onLog: (msg: string) => void,
  onStatus?: (percent: number, stage: string, detail?: string) => void
): Promise<void> => {
  const tempDir = mkdtempSync(join(tmpdir(), 'easyclaw-terminal-'))
  const scriptPath = join(tempDir, 'run.sh')
  const statusPath = join(tempDir, 'status.txt')
  const env = getPathEnv()
  const scriptEnv: NodeJS.ProcessEnv = { ...env }
  delete scriptEnv.npm_config_prefix
  delete scriptEnv.npm_config_cache

  const exportLines = Object.entries({
    PATH: env.PATH ?? ''
  })
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${shellEscape(value)}`)

  const script = [
    '#!/bin/bash',
    'set -u',
    ...exportLines,
    'unset npm_config_prefix',
    'unset npm_config_cache',
    'clear',
    `echo ${shellEscape(title)}`,
    'echo',
    'STATUS=0',
    '(',
    ...commands,
    ') || STATUS=$?',
    `printf '%s' \"$STATUS\" > ${shellEscape(statusPath)}`,
    'echo',
    'if [ \"$STATUS\" -eq 0 ]; then',
    "  echo '命令执行完成，可以返回安装器。'",
    'else',
    "  echo \"命令执行失败，退出码: $STATUS\"",
    'fi'
  ].join('\n')

  writeFileSync(scriptPath, `${script}\n`, { mode: 0o755 })

  const scriptArg = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('osascript', [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script "bash \\\"${scriptArg}\\\""`
    ], { env: scriptEnv })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`osascript failed with exit code ${code}`))
    })
    child.on('error', reject)
  })

  onLog(t('onboarder.externalTerminalOpened'))
  onStatus?.(72, t('onboarder.status.waitingExternal'), title)
  const exitCode = await waitForStatusFile(statusPath)
  rmSync(tempDir, { recursive: true, force: true })

  if (exitCode !== 0) {
    throw new Error(`Interactive terminal command failed with exit code ${exitCode}`)
  }
}

const runChannelCommand = async (
  runCmd: (cmd: string, args: string[], onLog: (msg: string) => void) => Promise<void>,
  onLog: (msg: string) => void,
  command: string,
  args: string[]
): Promise<void> => {
  await runCmd(command, args, onLog)
}

const resolveProviderModelId = (modelId: string | undefined, fallback: string): string => {
  if (!modelId) return fallback
  const [, resolved] = modelId.split('/')
  return resolved || modelId
}

const validateModelFamilyApiKey = async (
  apiKey: string,
  modelId?: string
): Promise<{ ok: true } | { ok: false; kind: 'auth' | 'timeout' | 'network'; message: string }> => {
  const payload = JSON.stringify({
    model: resolveProviderModelId(modelId, 'claude-opus-4-6'),
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }]
  })
  try {
    const response = await fetch('https://www.model-family.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: payload,
      signal: AbortSignal.timeout(PROVIDER_KEY_VALIDATION_TIMEOUT_MS)
    })

    if (response.ok) {
      return { ok: true }
    }

    const body = await response.text()
    let message = `HTTP ${response.status}`
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string }
      }
      if (json.error?.message) message = json.error.message
    } catch {
      if (body.trim()) message = body.trim()
    }

    const kind =
      response.status === 401 || /无效的令牌|invalid token/i.test(message) ? 'auth' : 'network'
    return { ok: false, kind, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const kind =
      /aborted|timeout/i.test(message) || error instanceof DOMException ? 'timeout' : 'network'
    return { ok: false, kind, message }
  }
}

const validateOpenAIApiKey = async (
  apiKey: string
): Promise<{ ok: true } | { ok: false; kind: 'auth' | 'timeout' | 'network'; message: string }> => {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(PROVIDER_KEY_VALIDATION_TIMEOUT_MS)
    })

    if (response.ok) return { ok: true }

    const body = await response.text()
    let message = `HTTP ${response.status}`
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string }
      }
      if (json.error?.message) message = json.error.message
    } catch {
      if (body.trim()) message = body.trim()
    }

    const kind =
      response.status === 401 || /invalid api key|incorrect api key|unauthorized/i.test(message)
        ? 'auth'
        : 'network'
    return { ok: false, kind, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const kind =
      /aborted|timeout/i.test(message) || error instanceof DOMException ? 'timeout' : 'network'
    return { ok: false, kind, message }
  }
}

const validateAnthropicApiKey = async (
  apiKey: string,
  modelId?: string
): Promise<{ ok: true } | { ok: false; kind: 'auth' | 'timeout' | 'network'; message: string }> => {
  const payload = JSON.stringify({
    model: resolveProviderModelId(modelId, 'claude-sonnet-4-6'),
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }]
  })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: payload,
      signal: AbortSignal.timeout(PROVIDER_KEY_VALIDATION_TIMEOUT_MS)
    })

    if (response.ok) return { ok: true }

    const body = await response.text()
    let message = `HTTP ${response.status}`
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string }
      }
      if (json.error?.message) message = json.error.message
    } catch {
      if (body.trim()) message = body.trim()
    }

    const kind =
      response.status === 401 || /invalid x-api-key|authentication/i.test(message)
        ? 'auth'
        : 'network'
    return { ok: false, kind, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const kind =
      /aborted|timeout/i.test(message) || error instanceof DOMException ? 'timeout' : 'network'
    return { ok: false, kind, message }
  }
}

const validateProviderBeforeChannelSetup = async (
  config: OnboardConfig,
  onLog: (msg: string) => void,
  onStatus?: (percent: number, stage: string, detail?: string) => void
): Promise<void> => {
  if (config.provider !== 'modelfamily' || config.authMethod === 'oauth' || !config.apiKey) return

  onStatus?.(58, t('onboarder.status.validatingProvider'))
  onLog(t('onboarder.providerValidating.modelfamily'))

  const result = await validateModelFamilyApiKey(config.apiKey, config.modelId)
  if (result.ok) {
    onLog(t('onboarder.providerValidatePassed.modelfamily'))
    return
  }

  if (result.kind === 'auth') {
    throw new Error(t('onboarder.providerValidateFailed.modelfamily', { message: result.message }))
  }

  onLog(t('onboarder.providerValidateSkipped.modelfamily', { message: result.message }))
}

export const validateProviderApiKey = async (config: {
  provider: OnboardConfig['provider']
  apiKey?: string
  authMethod?: 'api-key' | 'oauth'
  modelId?: string
}): Promise<ProviderKeyValidationResult> => {
  if (config.authMethod === 'oauth' || config.provider === 'ollama') {
    return { success: true }
  }

  if (!config.apiKey) {
    return { success: false, error: t('config.keyValidationFailed') }
  }

  const result =
    config.provider === 'modelfamily'
      ? await validateModelFamilyApiKey(config.apiKey, config.modelId)
      : config.provider === 'openai'
        ? await validateOpenAIApiKey(config.apiKey)
        : config.provider === 'anthropic'
          ? await validateAnthropicApiKey(config.apiKey, config.modelId)
          : { ok: true as const }

  if (result.ok) return { success: true }

  if (result.kind === 'timeout' || result.kind === 'network') {
    return {
      success: true,
      warning:
        config.provider === 'modelfamily'
          ? t('onboarder.providerValidateSkipped.modelfamily', { message: result.message })
          : config.provider === 'openai'
            ? t('onboarder.providerValidateSkipped.openai', { message: result.message })
            : config.provider === 'anthropic'
              ? t('onboarder.providerValidateSkipped.anthropic', { message: result.message })
              : result.message
    }
  }

  return {
    success: false,
    error:
      config.provider === 'modelfamily'
        ? t('onboarder.providerValidateFailed.modelfamily', { message: result.message })
        : config.provider === 'openai'
          ? t('onboarder.providerValidateFailed.openai', { message: result.message })
          : config.provider === 'anthropic'
            ? t('onboarder.providerValidateFailed.anthropic', { message: result.message })
          : result.message
  }
}

interface ResolvedMemorySearchConfig {
  enabled: boolean
  provider?: MemorySearchProvider
  apiKey?: string
  model?: string
  warning?: string
}

const validateMemorySearchApiKey = async (
  provider: MemorySearchProvider,
  apiKey: string
): Promise<{ ok: true } | { ok: false; kind: 'auth' | 'timeout' | 'network'; message: string }> =>
  provider === 'openai' ? validateOpenAIApiKey(apiKey) : validateGeminiApiKey(apiKey)

const resolveMemorySearchConfig = async (
  config: MemorySearchConfigPayload | undefined,
  onLog?: (msg: string) => void
): Promise<ResolvedMemorySearchConfig> => {
  if (!config?.enabled) {
    return { enabled: false }
  }

  const provider = config.provider
  const apiKey = config.apiKey?.trim()
  if (!provider || !apiKey) {
    const warning = t('onboarder.memorySearch.disabledMissing')
    onLog?.(warning)
    return { enabled: false, warning }
  }

  const result = await validateMemorySearchApiKey(provider, apiKey)
  if (!result.ok) {
    const warning = t('onboarder.memorySearch.disabledInvalid', {
      provider: MEMORY_SEARCH_PROVIDER_LABEL[provider],
      message: result.message
    })
    onLog?.(warning)
    return { enabled: false, warning }
  }

  const resolved: ResolvedMemorySearchConfig = {
    enabled: true,
    provider,
    apiKey,
    model: MEMORY_SEARCH_DEFAULT_MODELS[provider]
  }
  onLog?.(
    t('onboarder.memorySearch.enabled', {
      provider: MEMORY_SEARCH_PROVIDER_LABEL[provider],
      model: resolved.model
    })
  )
  return resolved
}

const applyMemorySearchConfig = (
  ocConfig: Record<string, unknown>,
  resolved: ResolvedMemorySearchConfig
): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = ocConfig as any
  cfg.agents = cfg.agents ?? {}
  cfg.agents.defaults = cfg.agents.defaults ?? {}
  cfg.agents.defaults.memorySearch = cfg.agents.defaults.memorySearch ?? {}

  if (!resolved.enabled) {
    cfg.agents.defaults.memorySearch = {
      ...cfg.agents.defaults.memorySearch,
      enabled: false
    }
    return
  }

  cfg.agents.defaults.memorySearch = {
    ...cfg.agents.defaults.memorySearch,
    enabled: true,
    provider: resolved.provider,
    model: resolved.model
  }

  cfg.models = cfg.models ?? {}
  cfg.models.providers = cfg.models.providers ?? {}

  const providerKey = MEMORY_SEARCH_PROVIDER_CONFIG_PATH[resolved.provider!]
  cfg.models.providers[providerKey] = {
    ...(cfg.models.providers[providerKey] ?? {}),
    apiKey: resolved.apiKey
  }
}

const runOneClickChannelSetup = async (
  _win: BrowserWindow,
  config: OnboardConfig,
  runCmd: (cmd: string, args: string[], onLog: (msg: string) => void) => Promise<void>,
  onLog: (msg: string) => void,
  ocBin: string,
  onStatus?: (percent: number, stage: string, detail?: string) => void
): Promise<void> => {
  if (config.channelType === 'wechat') {
    await ensureCommandAvailable('npm')
    await ensureCommandAvailable('npx')
    onLog(t('onboarder.channelOneClick.wechat'))
    if (platform() === 'darwin') {
      const commands = [
        `${shellEscape(resolvePreferredBin('npx'))} -y @tencent-weixin/openclaw-weixin-cli@latest install`
      ]
      await runMacTerminalScript('EasyClaw 微信渠道安装', commands, onLog, onStatus)
      onLog(t('onboarder.channelDone.wechat'))
      return
    }
    await runChannelCommand(
      runCmd,
      onLog,
      platform() === 'win32' ? 'npx' : resolvePreferredBin('npx'),
      ['-y', '@tencent-weixin/openclaw-weixin-cli@latest', 'install']
    )
    onLog(t('onboarder.channelDone.wechat'))
    return
  }

  if (config.channelType !== 'feishu' || config.channelSetupMode !== 'one-click') return

  await ensureCommandAvailable('npm')
  await ensureCommandAvailable('npx')
  onLog(t('onboarder.channelOneClick.feishu'))
  if (platform() === 'darwin') {
    const commands = [
      `${shellEscape(resolvePreferredBin('npx'))} -y ${LARK_PLUGIN_PACKAGE} install`,
      `test -f ${shellEscape(getConfigPath())}`,
      `${shellEscape(ocBin)} config set channels.feishu.streaming true`,
      `${shellEscape(ocBin)} gateway restart`,
      `echo ${shellEscape(t('onboarder.feishuAuthPrompt'))}`,
      `echo ${shellEscape(t('onboarder.feishuChatAuthPrompt'))}`
    ]
    await runMacTerminalScript('EasyClaw 飞书渠道安装', commands, onLog, onStatus)
    onLog(t('onboarder.channelDone.feishu'))
    return
  }
  await runChannelCommand(
    runCmd,
    onLog,
    platform() === 'win32' ? 'npx' : resolvePreferredBin('npx'),
    ['-y', LARK_PLUGIN_PACKAGE, 'install']
  )

  if (!(await hasOpenClawConfig())) {
    throw new Error(t('onboarder.openclawNotInitialized'))
  }

  onLog(t('onboarder.feishuStreaming'))
  await runChannelCommand(runCmd, onLog, ocBin, [
    'config',
    'set',
    'channels.feishu.streaming',
    'true'
  ])
  onLog(t('onboarder.gatewayRestarting'))
  await runChannelCommand(runCmd, onLog, ocBin, ['gateway', 'restart'])
  onLog(t('onboarder.feishuChatAuthPrompt'))
  onLog(t('onboarder.channelDone.feishu'))
}

const ensureFeishuStreamingEnabled = async (
  config: OnboardConfig,
  runCmd: (cmd: string, args: string[], onLog: (msg: string) => void) => Promise<void>,
  onLog: (msg: string) => void,
  ocBin: string
): Promise<void> => {
  if (config.channelType !== 'feishu') return

  if (!(await hasOpenClawConfig())) {
    throw new Error(t('onboarder.openclawNotInitialized'))
  }

  onLog(t('onboarder.feishuStreaming'))
  await runChannelCommand(runCmd, onLog, ocBin, [
    'config',
    'set',
    'channels.feishu.streaming',
    'true'
  ])

  onLog(t('onboarder.gatewayRestarting'))
  await runChannelCommand(runCmd, onLog, ocBin, ['gateway', 'restart'])
}

const wslKillOpenclaw = (): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn('wsl', [
      '-d',
      'Ubuntu',
      '-u',
      'root',
      '--',
      'pkill',
      '-9',
      '-f',
      'openclaw'
    ])
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })

const listMacProcesses = (): Promise<Array<{ pid: number; command: string }>> =>
  new Promise((resolve) => {
    const child = spawn('ps', ['-axo', 'pid=,command='])
    let output = ''

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8')
    })
    child.on('close', () => {
      const processes = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.+)$/)
          if (!match) return null
          return { pid: Number(match[1]), command: match[2] }
        })
        .filter((value): value is { pid: number; command: string } => value !== null)

      resolve(processes)
    })
    child.on('error', () => resolve([]))
  })

const killMacOpenClawProcesses = async (): Promise<void> => {
  const currentPid = process.pid
  const candidates = await listMacProcesses()
  const targetPids = candidates
    .filter(({ pid, command }) => {
      if (!Number.isFinite(pid) || pid <= 0 || pid === currentPid) return false
      return /(^|[ /])openclaw(?:-gateway)?([ ]|$)/.test(command)
    })
    .map(({ pid }) => pid)

  for (const pid of targetPids) {
    await new Promise<void>((resolve) => {
      const child = spawn('kill', ['-9', String(pid)])
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
  }
}

export const runOnboard = async (
  win: BrowserWindow,
  config: OnboardConfig
): Promise<OnboardResult> => {
  const progress = createInstallProgressEmitter(win)
  const log = progress.log
  const status = progress.status

  try {
    status(5, t('onboarder.status.preparing'))
    log(t('onboarder.starting'))

    const isWindows = platform() === 'win32'
    const isMac = platform() === 'darwin'
    const ocBin = isWindows ? 'openclaw' : resolvePreferredBin('openclaw')
    const fixPath = join(homedir(), '.openclaw', 'ipv4-fix.js')
    const runCmd = createRunCmd()

  // Prevent Telegram API ETIMEDOUT on environments without IPv6 (Node.js 22 autoSelectFamily)
  if (isMac) {
    const macOcDir = join(homedir(), '.openclaw')
    if (!existsSync(macOcDir)) mkdirSync(macOcDir, { recursive: true })
    const fixContent = [
      "const dns = require('dns')",
      'const origLookup = dns.lookup',
      'dns.lookup = function (hostname, options, callback) {',
      "  if (typeof options === 'function') { callback = options; options = { family: 4 } }",
      "  else if (typeof options === 'number') { options = { family: 4 } }",
      '  else { options = Object.assign({}, options, { family: 4 }) }',
      '  return origLookup.call(this, hostname, options, callback)',
      '}'
    ].join('\n')
    writeFileSync(fixPath, fixContent + '\n')

    await new Promise<void>((resolve) => {
      const child = spawn('launchctl', ['setenv', 'NODE_OPTIONS', `--require=${fixPath}`])
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
  }

  // Remove existing daemon + kill processes + clean up broken config
  if (isWindows) {
    await wslKillOpenclaw().catch(() => {})
    // Clean up config files inside WSL (preserve auth-profiles.json for OAuth)
    try {
      await runInWsl('rm -f /root/.openclaw/openclaw.json')
    } catch {
      /* ignore */
    }
    const wslAuthClean =
      config.authMethod === 'oauth'
        ? 'rm -f /root/.openclaw/agents/main/agent/auth.json'
        : 'rm -f /root/.openclaw/agents/main/agent/auth.json /root/.openclaw/agents/main/agent/auth-profiles.json'
    try {
      await runInWsl(wslAuthClean)
    } catch {
      /* ignore */
    }
  } else {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist')
    if (existsSync(plist)) {
      await new Promise<void>((resolve) => {
        const child = spawn('launchctl', ['unload', plist])
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
      try {
        unlinkSync(plist)
      } catch {
        /* ignore */
      }
    }
    await killMacOpenClawProcesses()
    const macOcDir = join(homedir(), '.openclaw')
    const configFile = join(macOcDir, 'openclaw.json')
    if (existsSync(configFile))
      try {
        unlinkSync(configFile)
      } catch {
        /* ignore */
      }
    const agentAuthDir = join(macOcDir, 'agents', 'main', 'agent')
    // OAuth: preserve auth-profiles.json since credentials were already saved
    const authFilesToClean =
      config.authMethod === 'oauth' ? ['auth.json'] : ['auth.json', 'auth-profiles.json']
    for (const f of authFilesToClean) {
      const p = join(agentAuthDir, f)
      if (existsSync(p))
        try {
          unlinkSync(p)
        } catch {
          /* ignore */
        }
    }
  }
  // Wait for port release + Telegram long-poll release
  await new Promise((resolve) => setTimeout(resolve, 5000))

  // OAuth: credentials already saved to auth-profiles.json, skip auth in onboard
  const effectiveProvider = config.authMethod === 'oauth' ? 'openai-codex' : config.provider
  const effectiveAuthFlags =
    config.authMethod === 'oauth'
      ? ['--auth-choice', 'skip']
      : config.provider === 'ollama'
        ? ['--auth-choice', 'ollama']
        : config.provider === 'deepseek' || config.provider === 'modelfamily'
          ? ['--auth-choice', 'skip']
          : {
              anthropic: ['--auth-choice', 'apiKey', '--anthropic-api-key', config.apiKey!],
              google: ['--auth-choice', 'gemini-api-key', '--gemini-api-key', config.apiKey!],
              openai: ['--auth-choice', 'openai-api-key', '--openai-api-key', config.apiKey!],
              minimax: ['--auth-choice', 'minimax-api', '--minimax-api-key', config.apiKey!],
              glm: ['--auth-choice', 'zai-api-key', '--zai-api-key', config.apiKey!]
            }[config.provider]

  const openclawArgs = [
    'onboard',
    '--non-interactive',
    '--accept-risk',
    '--mode',
    'local',
    ...effectiveAuthFlags,
    '--gateway-port',
    '18789',
    '--gateway-bind',
    'loopback',
    // Windows WSL: no daemon install needed since DoneStep starts as foreground process
    ...(isWindows ? [] : ['--install-daemon', '--daemon-runtime', 'node']),
    '--skip-skills'
  ]

  status(18, t('onboarder.status.initializing'))
  try {
    await runCmd(
      isWindows ? 'npm' : ocBin,
      isWindows ? ['exec', '--', 'openclaw', ...openclawArgs] : [...openclawArgs],
      log
    )
  } catch (e) {
    // Even if onboard fails with gateway connection test (1006),
    // continue if config file was created
    if (isWindows) {
      try {
        await readWslFile('/root/.openclaw/openclaw.json')
      } catch {
        throw e
      }
      log(t('onboarder.configCreatedSkipGw'))
    } else {
      const configPath = join(homedir(), '.openclaw', 'openclaw.json')
      if (!existsSync(configPath)) throw e
      log(t('onboarder.configCreatedSkipGw'))
    }
  }

  // Stop immediately since onboard --install-daemon starts the daemon
  if (isMac) {
    status(42, t('onboarder.status.stoppingOldGateway'))
    const uid = process.getuid?.() ?? ''
    await new Promise<void>((resolve) => {
      const child = spawn('launchctl', ['bootout', `gui/${uid}/ai.openclaw.gateway`])
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
    await new Promise<void>((resolve) => {
      killMacOpenClawProcesses().finally(resolve)
    })
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  const resolvedMemorySearch = await resolveMemorySearchConfig(config.memorySearch, log)

  // Set recommended model per provider
  const patchConfig = (ocConfig: Record<string, unknown>): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = ocConfig as any
    cfg.agents = cfg.agents ?? {}
    cfg.agents.defaults = cfg.agents.defaults ?? {}
    cfg.agents.defaults.model = {
      ...cfg.agents.defaults.model,
      primary: config.modelId || DEFAULT_MODELS[effectiveProvider]
    }
    // OAuth: register auth profile reference in config
    if (config.authMethod === 'oauth') {
      cfg.auth = cfg.auth ?? {}
      cfg.auth.profiles = {
        ...cfg.auth.profiles,
        [OAUTH_PROFILE_ID]: { provider: 'openai-codex', mode: 'oauth' }
      }
      cfg.auth.order = { ...cfg.auth.order, 'openai-codex': [OAUTH_PROFILE_ID] }
    }
    cfg.models = cfg.models ?? {}
    cfg.models.providers = cfg.models.providers ?? {}
    // DeepSeek: register custom provider (not built-in)
    if (config.provider === 'deepseek' && config.apiKey) {
      cfg.models.providers.deepseek = {
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        apiKey: config.apiKey,
        models: [
          { id: 'deepseek-chat', contextWindow: 128000, maxTokens: 8192 },
          { id: 'deepseek-reasoner', contextWindow: 128000, maxTokens: 64000 }
        ]
      }
    }
    if (config.provider === 'modelfamily' && config.apiKey) {
      cfg.models.providers.modelfamily = {
        baseUrl: 'https://www.model-family.com',
        apiKey: config.apiKey,
        auth: 'api-key',
        api: 'anthropic-messages',
        models: [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 500000,
            maxTokens: 32768
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 500000,
            maxTokens: 32768
          }
        ]
      }
    }
    const spec = MODEL_SPECS[config.provider]
    if (spec && cfg.models?.providers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const provider of Object.values(cfg.models.providers) as any[]) {
        if (Array.isArray(provider.models)) {
          for (const m of provider.models) {
            m.contextWindow = spec.contextWindow
            m.maxTokens = spec.maxTokens
          }
        }
      }
    }

    applyMemorySearchConfig(cfg, resolvedMemorySearch)
  }

  // Patch config file
  const baseConfig = await readOpenClawConfig()
  if (baseConfig) {
    patchConfig(baseConfig)
    await writeOpenClawConfig(baseConfig)
  }
  status(55, t('onboarder.status.applyingConfig'))
  log(t('onboarder.basicDone'))

  await validateProviderBeforeChannelSetup(config, log, status)

  // Apply IPv4 fix to plist (macOS only)
  if (isMac) {
    const plistAfter = join(homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist')
    if (existsSync(plistAfter)) {
      let xml = readFileSync(plistAfter, 'utf-8')
      if (!xml.includes('ipv4-fix')) {
        xml = xml.replace(
          '<string>/usr/local/bin/node</string>',
          `<string>/usr/local/bin/node</string>\n      <string>--require=${fixPath}</string>`
        )
      }
      const nodeOpt = `--require=${fixPath}`
      if (!xml.includes('NODE_OPTIONS')) {
        xml = xml.replace(
          '</dict>\n  </dict>',
          `<key>NODE_OPTIONS</key>\n    <string>${nodeOpt}</string>\n    </dict>\n  </dict>`
        )
      }
      writeFileSync(plistAfter, xml)
    }
  }

  let botUsername: string | undefined
  const channelPatch =
    config.channelType === 'feishu' && config.channelSetupMode !== 'manual'
      ? null
      : getChannelPatch(config)

  if (channelPatch) {
    status(62, t('onboarder.status.configuringChannel'))
    log(t(`onboarder.channelAdding.${channelPatch.key}`))

    const channelConfig = await readOpenClawConfig()
    if (channelConfig) {
      const existingChannels =
        channelConfig.channels && typeof channelConfig.channels === 'object'
          ? (channelConfig.channels as Record<string, unknown>)
          : {}
      channelConfig.channels = { ...existingChannels, [channelPatch.key]: channelPatch.value }
      await writeOpenClawConfig(channelConfig)
      log(t(`onboarder.channelDone.${channelPatch.key}`))
    } else {
      log(t('onboarder.configNotFound'))
    }
  }

  const requiresOneClickChannelSetup =
    config.channelType === 'wechat' ||
    (config.channelType === 'feishu' && config.channelSetupMode === 'one-click')

  if (config.channelType === 'feishu' && config.channelSetupMode === 'one-click') {
    status(68, t('onboarder.status.launchingFeishu'))
  } else if (config.channelType === 'wechat') {
    status(68, t('onboarder.status.launchingWechat'))
  }

  if (requiresOneClickChannelSetup) {
    await runOneClickChannelSetup(win, config, runCmd, log, ocBin, status)
  }

  if (config.channelType === 'feishu') {
    status(78, t('onboarder.feishuStreaming'))
    await ensureFeishuStreamingEnabled(config, runCmd, log, ocBin)
  }

  if (config.channelType === 'telegram' && config.telegramBotToken) {
    status(78, t('onboarder.status.checkingTelegram'))
    botUsername = await fetchBotUsername(config.telegramBotToken)
    log(t('onboarder.channelChecking.telegram'))
    await waitTelegramClear(config.telegramBotToken)
  }

  // Restart daemon after all patches are complete
  if (isWindows) {
    status(88, t('onboarder.status.finishing'))
    log(t('onboarder.cleaningGateway'))
    await wslKillOpenclaw().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 2000))
  } else if (isMac) {
    status(88, t('onboarder.status.finishing'))
    log(t('onboarder.startingGateway'))
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist')
    const uid = process.getuid?.() ?? ''
    if (existsSync(plistPath)) {
      await new Promise<void>((resolve) => {
        const child = spawn('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
    }
  }

    status(100, t('onboarder.status.completed'))

    return { botUsername }
  } finally {
    progress.dispose()
  }
}

// ─── Provider switch ───

export interface CurrentConfig {
  provider?: string
  model?: string
  hasChannel?: boolean
  channelType?: 'feishu' | 'wechat' | 'telegram'
  memorySearch?: CurrentMemorySearchConfig
  hasCredentials?: boolean
  gatewayMode?: string
  isConfigured?: boolean
  issues?: string[]
}

const hasLocalCredentialFiles = (): boolean => {
  const authDir = join(homedir(), '.openclaw', 'agents', 'main', 'agent')
  const authFiles = ['auth.json', 'auth-profiles.json']

  return authFiles.some((file) => {
    const filePath = join(authDir, file)
    try {
      return existsSync(filePath) && readFileSync(filePath, 'utf-8').trim().length > 0
    } catch {
      return false
    }
  })
}

const hasWslCredentialFiles = async (): Promise<boolean> => {
  try {
    const output = await runInWsl(
      "[ -s /root/.openclaw/agents/main/agent/auth.json ] || [ -s /root/.openclaw/agents/main/agent/auth-profiles.json ] && echo yes || true",
      10000
    )
    return output.trim().includes('yes')
  } catch {
    return false
  }
}

const validateGeminiApiKey = async (
  apiKey: string
): Promise<{ ok: true } | { ok: false; kind: 'auth' | 'timeout' | 'network'; message: string }> => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(PROVIDER_KEY_VALIDATION_TIMEOUT_MS)
      }
    )

    if (response.ok) return { ok: true }

    const body = await response.text()
    let message = `HTTP ${response.status}`
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string }
      }
      if (json.error?.message) message = json.error.message
    } catch {
      if (body.trim()) message = body.trim()
    }

    const kind =
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403 ||
      /api key|permission|unauth/i.test(message)
        ? 'auth'
        : 'network'
    return { ok: false, kind, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const kind =
      /aborted|timeout/i.test(message) || error instanceof DOMException ? 'timeout' : 'network'
    return { ok: false, kind, message }
  }
}

export const readCurrentConfig = async (): Promise<CurrentConfig | null> => {
  try {
    await ensureOptionalMemorySearchDisabled()
    const cfg = await readOpenClawConfig()
    if (!cfg) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typed = cfg as any
    const model = typed?.agents?.defaults?.model?.primary as string | undefined
    const channelType = getActiveChannelType(typed?.channels)
    const hasChannel = !!channelType
    const rawMemorySearch = typed?.agents?.defaults?.memorySearch as
      | { enabled?: boolean; provider?: string }
      | undefined
    const memorySearchProvider =
      rawMemorySearch?.provider === 'openai' || rawMemorySearch?.provider === 'gemini'
        ? rawMemorySearch.provider
        : undefined
    const memorySearchEnabled =
      rawMemorySearch?.enabled === false ? false : memorySearchProvider !== undefined
    const gatewayMode = typed?.gateway?.mode as string | undefined
    // Extract provider from model ID (e.g. "anthropic/claude-sonnet-4-6" → "anthropic")
    const provider = model?.split('/')[0]
    const providerConfig = provider ? typed?.models?.providers?.[provider] : undefined
    const hasEmbeddedCredential =
      typeof providerConfig?.apiKey === 'string' && providerConfig.apiKey.trim().length > 0
    const hasConfigAuthProfile = Object.keys(typed?.auth?.profiles ?? {}).length > 0
    const isWindows = platform() === 'win32'
    const hasCredentialFiles = isWindows ? await hasWslCredentialFiles() : hasLocalCredentialFiles()
    const hasCredentials = provider
      ? provider === 'ollama' || hasEmbeddedCredential || hasConfigAuthProfile || hasCredentialFiles
      : false

    const issues: string[] = []
    if (!model || !provider) issues.push('missing-model')
    if (gatewayMode !== 'local') issues.push('missing-gateway-mode')
    if (provider && provider !== 'ollama' && !hasCredentials) issues.push('missing-credentials')

    return {
      provider,
      model,
      hasChannel,
      channelType,
      memorySearch: {
        enabled: memorySearchEnabled,
        ...(memorySearchProvider ? { provider: memorySearchProvider } : {})
      },
      hasCredentials,
      gatewayMode,
      isConfigured: issues.length === 0,
      issues
    }
  } catch {
    return null
  }
}

export const switchProvider = async (
  win: BrowserWindow,
  config: {
    provider: OnboardConfig['provider']
    apiKey?: string
    authMethod?: 'api-key' | 'oauth'
    modelId?: string
    memorySearch?: MemorySearchConfigPayload
  }
): Promise<{ warning?: string }> => {
  const progress = createInstallProgressEmitter(win)
  const log = progress.log

  try {
    const isWindows = platform() === 'win32'
    const isMac = platform() === 'darwin'
    const ocBin = isWindows ? 'openclaw' : resolvePreferredBin('openclaw')
    const runCmd = createRunCmd()

    log(t('onboarder.switchStarting'))

  // 1. Preserve existing channel config
  let savedChannels: Record<string, unknown> | null = null
  let savedTelegram: Record<string, unknown> | null = null
  try {
    let raw: string
    if (isWindows) {
      raw = await readWslFile('/root/.openclaw/openclaw.json')
    } else {
      raw = readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = JSON.parse(raw) as any
    if (cfg?.channels && typeof cfg.channels === 'object') {
      savedChannels = cfg.channels
    }
    if (cfg?.channels?.telegram?.botToken) {
      savedTelegram = cfg.channels.telegram
    }
  } catch {
    /* no config yet */
  }

  // 2. Prevent Telegram 409 conflict
  if (savedTelegram && (savedTelegram as { botToken?: string }).botToken) {
    log(t('onboarder.cleaningTelegram'))
    await waitTelegramClear((savedTelegram as { botToken: string }).botToken)
  }

  // 3. Clean up existing processes
  log(t('onboarder.cleaningGateway'))
  if (isWindows) {
    await wslKillOpenclaw().catch(() => {})
  } else {
    await killMacOpenClawProcesses()
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))

  // 4. Delete existing config/auth files (preserve auth-profiles.json for OAuth)
  const preserveAuthProfiles = config.authMethod === 'oauth'
  if (isWindows) {
    try {
      await runInWsl('rm -f /root/.openclaw/openclaw.json')
    } catch {
      /* ignore */
    }
    const wslAuthClean = preserveAuthProfiles
      ? 'rm -f /root/.openclaw/agents/main/agent/auth.json'
      : 'rm -f /root/.openclaw/agents/main/agent/auth.json /root/.openclaw/agents/main/agent/auth-profiles.json'
    try {
      await runInWsl(wslAuthClean)
    } catch {
      /* ignore */
    }
  } else {
    const ocDir = join(homedir(), '.openclaw')
    const filesToClean = [
      'openclaw.json',
      join('agents', 'main', 'agent', 'auth.json'),
      ...(preserveAuthProfiles ? [] : [join('agents', 'main', 'agent', 'auth-profiles.json')])
    ]
    for (const f of filesToClean) {
      const p = join(ocDir, f)
      if (existsSync(p))
        try {
          unlinkSync(p)
        } catch {
          /* ignore */
        }
    }
  }

  // 5. Re-run openclaw onboard
  log(t('onboarder.settingNewProvider'))
  // OAuth: credentials already saved to auth-profiles.json, skip auth in onboard
  const effectiveProvider = config.authMethod === 'oauth' ? 'openai-codex' : config.provider
  const effectiveAuthFlags =
    config.authMethod === 'oauth'
      ? ['--auth-choice', 'skip']
      : config.provider === 'ollama'
        ? ['--auth-choice', 'ollama']
        : config.provider === 'deepseek' || config.provider === 'modelfamily'
          ? ['--auth-choice', 'skip']
          : {
              anthropic: ['--auth-choice', 'apiKey', '--anthropic-api-key', config.apiKey!],
              google: ['--auth-choice', 'gemini-api-key', '--gemini-api-key', config.apiKey!],
              openai: ['--auth-choice', 'openai-api-key', '--openai-api-key', config.apiKey!],
              minimax: ['--auth-choice', 'minimax-api', '--minimax-api-key', config.apiKey!],
              glm: ['--auth-choice', 'zai-api-key', '--zai-api-key', config.apiKey!]
            }[config.provider]

  const openclawArgs = [
    'onboard',
    '--non-interactive',
    '--accept-risk',
    '--mode',
    'local',
    ...effectiveAuthFlags,
    '--gateway-port',
    '18789',
    '--gateway-bind',
    'loopback',
    ...(isWindows ? [] : ['--install-daemon', '--daemon-runtime', 'node']),
    '--skip-skills'
  ]

  try {
    await runCmd(
      isWindows ? 'npm' : ocBin,
      isWindows ? ['exec', '--', 'openclaw', ...openclawArgs] : [...openclawArgs],
      log
    )
  } catch (e) {
    if (isWindows) {
      try {
        await readWslFile('/root/.openclaw/openclaw.json')
      } catch {
        throw e
      }
    } else {
      if (!existsSync(join(homedir(), '.openclaw', 'openclaw.json'))) throw e
    }
    log(t('onboarder.configCreatedSkipGw'))
  }

  // 6. Stop daemon immediately (macOS)
  if (isMac) {
    const uid = process.getuid?.() ?? ''
    await new Promise<void>((resolve) => {
      const child = spawn('launchctl', ['bootout', `gui/${uid}/ai.openclaw.gateway`])
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
    await new Promise<void>((resolve) => {
      killMacOpenClawProcesses().finally(resolve)
    })
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  const resolvedMemorySearch = await resolveMemorySearchConfig(config.memorySearch, log)

  // 7. Patch model
  log(t('onboarder.applyingModel'))

  const patchSwitchConfig = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ocConfig: any,
    channels: Record<string, unknown> | null
  ): void => {
    ocConfig.agents = ocConfig.agents ?? {}
    ocConfig.agents.defaults = ocConfig.agents.defaults ?? {}
    ocConfig.agents.defaults.model = {
      ...ocConfig.agents.defaults.model,
      primary: config.modelId || DEFAULT_MODELS[effectiveProvider]
    }
    // OAuth: register auth profile reference in config
    if (config.authMethod === 'oauth') {
      ocConfig.auth = ocConfig.auth ?? {}
      ocConfig.auth.profiles = {
        ...ocConfig.auth.profiles,
        [OAUTH_PROFILE_ID]: { provider: 'openai-codex', mode: 'oauth' }
      }
      ocConfig.auth.order = { ...ocConfig.auth.order, 'openai-codex': [OAUTH_PROFILE_ID] }
    }
    ocConfig.models = ocConfig.models ?? {}
    ocConfig.models.providers = ocConfig.models.providers ?? {}
    // DeepSeek: register custom provider (not built-in)
    if (config.provider === 'deepseek' && config.apiKey) {
      ocConfig.models.providers.deepseek = {
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        apiKey: config.apiKey,
        models: [
          { id: 'deepseek-chat', contextWindow: 128000, maxTokens: 8192 },
          { id: 'deepseek-reasoner', contextWindow: 128000, maxTokens: 64000 }
        ]
      }
    }
    if (config.provider === 'modelfamily' && config.apiKey) {
      ocConfig.models.providers.modelfamily = {
        baseUrl: 'https://www.model-family.com',
        apiKey: config.apiKey,
        auth: 'api-key',
        api: 'anthropic-messages',
        models: [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 500000,
            maxTokens: 32768
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 500000,
            maxTokens: 32768
          }
        ]
      }
    }
    const spec = MODEL_SPECS[effectiveProvider as OnboardConfig['provider']]
    if (spec && ocConfig.models?.providers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const provider of Object.values(ocConfig.models.providers) as any[]) {
        if (Array.isArray(provider.models)) {
          for (const m of provider.models) {
            m.contextWindow = spec.contextWindow
            m.maxTokens = spec.maxTokens
          }
        }
      }
    }
    applyMemorySearchConfig(ocConfig, resolvedMemorySearch)
    // Restore previous channel config
    if (channels) {
      ocConfig.channels = { ...ocConfig.channels, ...channels }
    }
  }

  if (isWindows) {
    try {
      const raw = await readWslFile('/root/.openclaw/openclaw.json')
      const ocConfig = JSON.parse(raw)
      patchSwitchConfig(ocConfig, savedChannels)
      await writeWslFile('/root/.openclaw/openclaw.json', JSON.stringify(ocConfig, null, 2))
    } catch {
      /* config not found */
    }
  } else {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json')
    if (existsSync(configPath)) {
      const ocConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
      patchSwitchConfig(ocConfig, savedChannels)
      writeFileSync(configPath, JSON.stringify(ocConfig, null, 2), { mode: 0o600 })
    }
  }

    log(t('onboarder.switchDone'))
    return resolvedMemorySearch.warning ? { warning: resolvedMemorySearch.warning } : {}
  } finally {
    progress.dispose()
  }
}

// ─── Channel-only update (non-destructive) ───

export const setupChannelOnly = async (
  win: BrowserWindow,
  config: OnboardConfig
): Promise<{ success: boolean; error?: string; botUsername?: string }> => {
  const log = (msg: string): void => {
    try {
      win.webContents.send('install:progress', msg)
    } catch { /* window destroyed */ }
  }
  const status = (percent: number, stage: string, detail?: string): void => {
    try {
      win.webContents.send('install:status', { percent: Math.round(percent), stage, detail })
    } catch { /* window destroyed */ }
  }

  const isWin = platform() === 'win32'
  const ocBin = isWin ? 'openclaw' : resolvePreferredBin('openclaw')
  const runCmd = isWin
    ? async (cmd: string, args: string[], onLog: (m: string) => void): Promise<void> => {
        await runInWsl(`${cmd} ${args.join(' ')}`, 120000)
        onLog(`${cmd} ${args.join(' ')} done`)
      }
    : async (cmd: string, args: string[], onLog: (m: string) => void): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(cmd, args, { env: getPathEnv() })
          child.stdout.on('data', (d) => onLog(d.toString().trim()))
          child.stderr.on('data', (d) => onLog(d.toString().trim()))
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
          child.on('error', reject)
        })
      }

  try {
    // For feishu/wechat one-click, run the external CLI tool
    if (
      (config.channelType === 'wechat') ||
      (config.channelType === 'feishu' && config.channelSetupMode === 'one-click')
    ) {
      status(20, t('onboarder.status.configuringChannel'))
      await runOneClickChannelSetup(win, config, runCmd, log, ocBin, status)
      status(100, t('onboarder.channelDone.' + config.channelType))
      return { success: true }
    }

    // For feishu manual or telegram, patch config directly
    const channelPatch = getChannelPatch(config)
    if (channelPatch) {
      status(30, t('onboarder.status.configuringChannel'))
      const cfg = await readOpenClawConfig()
      if (!cfg) {
        return { success: false, error: 'OpenClaw config not found' }
      }
      const channels = (cfg.channels ?? {}) as Record<string, unknown>
      channels[channelPatch.key] = channelPatch.value
      cfg.channels = channels
      await writeOpenClawConfig(cfg)
      log(`Channel ${channelPatch.key} config updated`)
    }

    // For feishu manual, also enable streaming
    if (config.channelType === 'feishu') {
      status(60, t('onboarder.feishuStreaming'))
      await ensureFeishuStreamingEnabled(config, runCmd, log, ocBin)
    }

    // For telegram, validate and clear queue
    let botUsername: string | undefined
    if (config.channelType === 'telegram' && config.telegramBotToken) {
      status(70, t('onboarder.status.checkingTelegram'))
      botUsername = await fetchBotUsername(config.telegramBotToken)
      await waitTelegramClear(config.telegramBotToken)
    }

    status(100, t('onboarder.status.completed'))
    return { success: true, botUsername }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const updateChannel = async (
  channelType: 'telegram',
  channelConfig: { botToken: string }
): Promise<{ success: boolean; error?: string; botUsername?: string }> => {
  try {
    // Validate token first
    const botUsername = await fetchBotUsername(channelConfig.botToken)
    if (!botUsername) {
      return { success: false, error: 'Invalid Telegram Bot Token' }
    }

    // Read existing config
    const cfg = (await readOpenClawConfig()) as Record<string, unknown> | null
    if (!cfg) {
      return { success: false, error: 'OpenClaw config not found' }
    }

    // Merge channel config without touching other settings
    const channels = (cfg.channels ?? {}) as Record<string, unknown>
    channels[channelType] = {
      enabled: true,
      botToken: channelConfig.botToken,
      dmPolicy: 'open',
      allowFrom: ['*'],
      groups: { '*': { requireMention: true } }
    }
    cfg.channels = channels

    // Write back
    await writeOpenClawConfig(cfg)

    // Clear pending Telegram updates
    await waitTelegramClear(channelConfig.botToken)

    return { success: true, botUsername }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
