import { ipcMain, BrowserWindow, app, shell } from 'electron'
import { spawn } from 'child_process'
import { platform, homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { checkEnvironment, checkOpenclawUpdate } from './services/env-checker'
import { getPathEnv, resolvePreferredBin } from './services/path-utils'
import { checkPort, runDoctorFix } from './services/troubleshooter'
import {
  beginInstallTask,
  buildInstallFailureMessage,
  cancelActiveInstall,
  endInstallTask,
  installNodeMac,
  installOpenClaw,
  installWsl,
  installNodeWsl,
  installOpenClawWsl
} from './services/installer'
import {
  cancelActiveOnboard,
  disableRetainedIncompatiblePlugins,
  inspectRetainedPluginCompatibility,
  runOnboard,
  readCurrentConfig,
  switchProvider,
  validateProviderApiKey,
  updateChannel,
  setupChannelOnly
} from './services/onboarder'
import {
  startGateway,
  stopGateway,
  restartGateway,
  getGatewayStatus,
  setGatewayLogCallback,
  setGatewayStatusCallback
} from './services/gateway'
import { checkWslState, readWslFile } from './services/wsl-utils'
import { checkForUpdates, downloadUpdate, installUpdate } from './services/updater'
import { cleanUninstallOpenClaw, uninstallOpenClaw } from './services/uninstaller'
import { exportBackup, importBackup } from './services/backup'
import { loginOpenAICodex } from './services/oauth'
import { executeAiRepairPlan, planAiRepair, runAiRepair } from './services/ai-repair'
import {
  getOpenclawVersionCatalog,
  normalizeInstallSourceMode,
  normalizeOpenclawVersion,
  type InstallSourceMode
} from './services/install-sources'

interface WizardPersistedState {
  step: string
  wslInstalled: boolean
  timestamp: number
}

const getWizardStatePath = (): string => join(app.getPath('userData'), 'wizard-state.json')
const getSettingsPath = (): string => join(app.getPath('userData'), 'settings.json')
const INSTALLER_INITIALIZED_KEY = '__installerInitialized'

const readSettings = (): Record<string, unknown> => {
  try {
    const p = getSettingsPath()
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    /* ignore */
  }
  return {}
}

const writeSettings = (patch: Record<string, unknown>): void => {
  const settings = { ...readSettings(), ...patch }
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2))
}

const getInstallSourceSettings = (): {
  sourceMode: InstallSourceMode
  openclawVersion: string
} => {
  const settings = readSettings()
  return {
    sourceMode: normalizeInstallSourceMode(
      typeof settings.sourceMode === 'string' ? settings.sourceMode : undefined
    ),
    openclawVersion: normalizeOpenclawVersion(
      typeof settings.openclawVersion === 'string' ? settings.openclawVersion : undefined
    )
  }
}

const applyInstallSourceSettings = (): void => {
  const { sourceMode } = getInstallSourceSettings()
  process.env.OPENCLAW_INSTALL_SOURCE_MODE = sourceMode
}

export const applySavedInstallSourceSettings = (): void => {
  applyInstallSourceSettings()
}

export const getSavedLocale = (): string => {
  return 'zh'
}

export const registerIpcHandlers = (getWin: () => BrowserWindow | null): void => {
  const win = (): BrowserWindow => {
    const w = getWin()
    if (!w || w.isDestroyed()) throw new Error('No active window')
    return w
  }

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('settings:get-install-sources', () => getInstallSourceSettings())
  ipcMain.handle(
    'settings:set-install-sources',
    (
      _e,
      patch: {
        sourceMode?: InstallSourceMode
        openclawVersion?: string
      }
    ) => {
      writeSettings({
        sourceMode: normalizeInstallSourceMode(patch.sourceMode),
        ...(patch.openclawVersion
          ? { openclawVersion: normalizeOpenclawVersion(patch.openclawVersion) }
          : {})
      })
      applyInstallSourceSettings()
      return { success: true }
    }
  )
  ipcMain.handle(
    'openclaw:list-versions',
    async (
      _e,
      opts?: {
        sourceMode?: InstallSourceMode
      }
    ) => {
      const sourceMode = normalizeInstallSourceMode(opts?.sourceMode)
      const catalog = await getOpenclawVersionCatalog(sourceMode)
      return {
        success: true,
        ...catalog
      }
    }
  )
  ipcMain.handle(
    'openclaw:inspect-plugin-compatibility',
    async (
      _e,
      opts?: {
        version?: string
      }
    ) => {
      try {
        const version = normalizeOpenclawVersion(opts?.version)
        const report = await inspectRetainedPluginCompatibility(version)
        return { success: true, ...report }
      } catch (e) {
        return {
          success: false,
          targetVersion: normalizeOpenclawVersion(opts?.version),
          entries: [],
          autoSyncCount: 0,
          warningCount: 0,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
  )
  ipcMain.handle(
    'openclaw:disable-incompatible-plugins',
    async (
      _e,
      opts?: {
        version?: string
      }
    ) => {
      try {
        const version = normalizeOpenclawVersion(opts?.version)
        const result = await disableRetainedIncompatiblePlugins(version, (msg) => {
          try {
            win().webContents.send('install:progress', msg)
          } catch {
            /* window destroyed */
          }
        })
        return {
          success: true,
          disabledIds: result.disabledIds,
          ...result.report
        }
      } catch (e) {
        return {
          success: false,
          disabledIds: [],
          targetVersion: normalizeOpenclawVersion(opts?.version),
          entries: [],
          autoSyncCount: 0,
          warningCount: 0,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
  )

  ipcMain.handle('env:check', () => {
    applyInstallSourceSettings()
    const isFreshInstallerLaunch = readSettings()[INSTALLER_INITIALIZED_KEY] !== true
    writeSettings({ [INSTALLER_INITIALIZED_KEY]: true })
    return checkEnvironment().then((result) => ({
      ...result,
      freshInstallerLaunch: isFreshInstallerLaunch
    }))
  })
  ipcMain.handle('openclaw:check-update', () => {
    applyInstallSourceSettings()
    return checkOpenclawUpdate()
  })

  ipcMain.handle(
    'openclaw:update-channel',
    async (_e, channelType: 'telegram', channelConfig: { botToken: string }) => {
      try {
        const result = await updateChannel(channelType, channelConfig)
        if (result.success) {
          // Restart gateway to pick up new channel config
          await restartGateway()
        }
        return result
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('onboard:channel-only', async (_e, config) => {
    try {
      const result = await setupChannelOnly(win(), config)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'ONBOARD_CANCELLED') {
        return { success: false, error: msg }
      }
      try {
        win().webContents.send('install:error', msg)
      } catch {
        /* window destroyed */
      }
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('openclaw:clean-uninstall', async () => {
    try {
      await cleanUninstallOpenClaw()
      const wizardStatePath = getWizardStatePath()
      if (existsSync(wizardStatePath)) unlinkSync(wizardStatePath)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('openclaw:dashboard', async () => {
    try {
      if (platform() === 'win32') {
        let raw: string
        try {
          raw = await readWslFile('/root/.openclaw/openclaw.json')
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err)
          }
        }
        const cfg = JSON.parse(raw) as {
          gateway?: { auth?: { token?: string } }
        }
        const token = cfg.gateway?.auth?.token
        const dashboardUrl = token
          ? `http://127.0.0.1:18789/#token=${encodeURIComponent(token)}`
          : 'http://127.0.0.1:18789/'
        await shell.openExternal(dashboardUrl)
        return { success: true }
      }

      const configPath = join(homedir(), '.openclaw', 'openclaw.json')
      if (existsSync(configPath)) {
        try {
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as {
            gateway?: { auth?: { token?: string } }
          }
          const token = cfg.gateway?.auth?.token
          const dashboardUrl = token
            ? `http://127.0.0.1:18789/#token=${encodeURIComponent(token)}`
            : 'http://127.0.0.1:18789/'
          await shell.openExternal(dashboardUrl)
          return { success: true }
        } catch {
          /* fall back to CLI dashboard */
        }
      }

      const openclaw = resolvePreferredBin('openclaw')
      return await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const child = spawn(openclaw, ['dashboard'], {
          env: getPathEnv(),
          stdio: 'ignore',
          detached: true
        })
        child.unref()
        child.on('error', (err) => resolve({ success: false, error: err.message }))
        setTimeout(() => resolve({ success: true }), 1000)
      })
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // WSL-related IPC
  ipcMain.handle('wsl:check', () => checkWslState())

  ipcMain.handle('wsl:install', async (_e, prevState?: string) => {
    try {
      const result = await installWsl(win(), prevState as Parameters<typeof installWsl>[1])
      return { success: true, needsReboot: result.needsReboot, state: result.state }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      try {
        win().webContents.send('install:error', msg)
      } catch {
        /* window destroyed */
      }
      return { success: false, error: msg }
    }
  })

  // Wizard state persistence IPC
  ipcMain.handle('wizard:save-state', (_e, state: WizardPersistedState) => {
    try {
      writeFileSync(getWizardStatePath(), JSON.stringify(state))
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('wizard:load-state', () => {
    try {
      const path = getWizardStatePath()
      if (!existsSync(path)) return null
      const state: WizardPersistedState = JSON.parse(readFileSync(path, 'utf-8'))
      // Expire after 24 hours
      if (Date.now() - state.timestamp > 24 * 60 * 60 * 1000) {
        unlinkSync(path)
        return null
      }
      return state
    } catch {
      return null
    }
  })

  ipcMain.handle('wizard:clear-state', () => {
    try {
      const path = getWizardStatePath()
      if (existsSync(path)) unlinkSync(path)
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('install:node', async () => {
    beginInstallTask()
    try {
      applyInstallSourceSettings()
      if (platform() === 'win32') {
        await installNodeWsl(win())
      } else {
        await installNodeMac(win())
      }
      return { success: true }
    } catch (e) {
      const msg = await buildInstallFailureMessage('node', e)
      try {
        win().webContents.send('install:error', msg)
      } catch {
        /* window destroyed */
      }
      return { success: false, error: msg }
    } finally {
      endInstallTask()
    }
  })

  ipcMain.handle(
    'install:openclaw',
    async (
      _e,
      opts?: {
        version?: string
      }
    ) => {
      beginInstallTask()
      try {
        applyInstallSourceSettings()
        const configuredVersion = opts?.version
          ? normalizeOpenclawVersion(opts.version)
          : getInstallSourceSettings().openclawVersion
        if (platform() === 'win32') {
          await installOpenClawWsl(win(), configuredVersion)
        } else {
          await installOpenClaw(win(), configuredVersion)
        }
        return { success: true }
      } catch (e) {
        const msg = await buildInstallFailureMessage('openclaw', e)
        try {
          win().webContents.send('install:error', msg)
        } catch {
          /* window destroyed */
        }
        return { success: false, error: msg }
      } finally {
        endInstallTask()
      }
    }
  )

  ipcMain.handle('install:cancel', () => {
    const cancelled = cancelActiveInstall()
    try {
      win().webContents.send(
        'install:error',
        cancelled ? 'INSTALL_CANCELLED' : '当前没有正在执行的安装任务'
      )
    } catch {
      /* window destroyed */
    }
    return { success: true, cancelled }
  })

  ipcMain.handle(
    'onboard:run',
    async (
      _e,
      config: {
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
        memorySearch?: {
          enabled?: boolean
          provider?: 'openai' | 'gemini'
          apiKey?: string
        }
      }
    ) => {
      try {
        const result = await runOnboard(win(), config)
        return { success: true, botUsername: result.botUsername }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === 'ONBOARD_CANCELLED') {
          return { success: false, error: msg }
        }
        try {
          win().webContents.send('install:error', msg)
        } catch {
          /* window destroyed */
        }
        return { success: false, error: msg }
      }
    }
  )

  ipcMain.handle('onboard:cancel', () => {
    const cancelled = cancelActiveOnboard()
    try {
      win().webContents.send(
        'install:error',
        cancelled ? 'ONBOARD_CANCELLED' : '当前没有正在执行的渠道配置任务'
      )
    } catch {
      /* window destroyed */
    }
    return { success: true, cancelled }
  })

  ipcMain.handle('oauth:openai-codex', async () => {
    try {
      await loginOpenAICodex()
      return { success: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, error: msg }
    }
  })

  // Read config / switch provider
  ipcMain.handle('config:read', async () => {
    try {
      const config = await readCurrentConfig()
      return { success: true, config }
    } catch (e) {
      return { success: false, config: null, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'config:validate-api-key',
    async (
      _e,
      config: {
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
        modelId?: string
      }
    ) => {
      try {
        return await validateProviderApiKey(config)
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle(
    'config:switch-provider',
    async (
      _e,
      config: {
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
        modelId?: string
        memorySearch?: {
          enabled?: boolean
          provider?: 'openai' | 'gemini'
          apiKey?: string
        }
      }
    ) => {
      try {
        const result = await switchProvider(win(), config)
        await restartGateway()
        return { success: true, warning: result.warning }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          win().webContents.send('install:error', msg)
        } catch {
          /* window destroyed */
        }
        return { success: false, error: msg }
      }
    }
  )

  // Forward Gateway logs to renderer
  setGatewayLogCallback((msg) => {
    try {
      win().webContents.send('gateway:log', msg)
    } catch {
      /* window destroyed */
    }
  })
  setGatewayStatusCallback((status) => {
    try {
      win().webContents.send('gateway:status-changed', status)
    } catch {
      /* window destroyed */
    }
  })

  ipcMain.handle('gateway:start', async () => {
    try {
      const result = await startGateway()
      const success = result.status === 'started'
      return { success, error: result.error }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('gateway:stop', async () => {
    try {
      await stopGateway()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('gateway:restart', async () => {
    try {
      const result = await restartGateway()
      const success = result.status === 'started'
      return { success, error: result.error }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('gateway:status', () => getGatewayStatus())

  ipcMain.handle('troubleshoot:check-port', () => checkPort())
  ipcMain.handle('troubleshoot:doctor-fix', () => runDoctorFix(win()))
  ipcMain.handle(
    'troubleshoot:ai-repair-plan',
    async (
      _e,
      payload?: {
        logs?: string[]
      }
    ) => {
      try {
        return await planAiRepair(win(), payload)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          win().webContents.send('install:error', msg)
        } catch {
          /* window destroyed */
        }
        return {
          success: false,
          summary: 'AI 修复计划生成失败。',
          source: 'fallback' as const,
          actions: [],
          requiresApproval: false,
          error: msg
        }
      }
    }
  )
  ipcMain.handle(
    'troubleshoot:ai-repair-execute',
    async (
      _e,
      payload: {
        planId: string
      }
    ) => {
      try {
        return await executeAiRepairPlan(win(), payload)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          win().webContents.send('install:error', msg)
        } catch {
          /* window destroyed */
        }
        return {
          success: false,
          summary: 'AI 修复执行失败。',
          actions: [],
          error: msg
        }
      }
    }
  )
  ipcMain.handle(
    'troubleshoot:ai-repair',
    async (
      _e,
      payload?: {
        logs?: string[]
      }
    ) => {
      try {
        return await runAiRepair(win(), payload)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          win().webContents.send('install:error', msg)
        } catch {
          /* window destroyed */
        }
        return {
          success: false,
          summary: 'AI 修复执行失败。',
          actions: [],
          error: msg
        }
      }
    }
  )

  ipcMain.handle('newsletter:subscribe', async (_e, email: string) => {
    try {
      const r = await fetch('https://www.model-family.com/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'app' })
      })
      if (!r.ok) return { success: false }
      const data = await r.json()
      return { success: data.success !== false }
    } catch {
      return { success: false }
    }
  })

  ipcMain.on('system:reboot', () => {
    if (platform() !== 'win32') return
    const child = spawn('shutdown', ['/r', '/t', '0'], {
      shell: true,
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
  })

  // Auto update IPC
  ipcMain.handle('update:check', () => {
    checkForUpdates()
    return { success: true }
  })

  ipcMain.handle('update:download', () => {
    downloadUpdate()
    return { success: true }
  })

  ipcMain.handle('update:install', () => {
    installUpdate()
    return { success: true }
  })

  // Auto launch IPC
  ipcMain.handle('autolaunch:get', () => ({
    enabled: app.getLoginItemSettings().openAtLogin
  }))

  ipcMain.handle('autolaunch:set', (_e, enabled: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true
    })
    return { success: true }
  })

  // Uninstall OpenClaw
  ipcMain.handle(
    'uninstall:openclaw',
    async (_e, opts: { removeConfig: boolean; unregisterWsl?: boolean }) => {
      try {
        await uninstallOpenClaw(win(), opts)
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // Backup / restore
  ipcMain.handle('backup:export', () => exportBackup(win()))
  ipcMain.handle('backup:import', () => importBackup(win()))
}
