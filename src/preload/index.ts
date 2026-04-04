import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
  env: {
    check: (): Promise<{
      os: 'macos' | 'windows' | 'linux'
      nodeInstalled: boolean
      nodeVersion: string | null
      nodeVersionOk: boolean
      openclawInstalled: boolean
      openclawVersion: string | null
      openclawLatestVersion: string | null
      wslState?:
        | 'not_available'
        | 'not_installed'
        | 'needs_reboot'
        | 'no_distro'
        | 'not_initialized'
        | 'ready'
      wslProxyInfo?: {
        enabled: boolean
        displayValue?: string
        needsAutoBridge: boolean
      }
    }> => ipcRenderer.invoke('env:check')
  },
  settings: {
    getInstallSources: (): Promise<{
      sourceMode: 'auto' | 'official' | 'mirror'
    }> => ipcRenderer.invoke('settings:get-install-sources'),
    setInstallSources: (patch: {
      sourceMode?: 'auto' | 'official' | 'mirror'
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('settings:set-install-sources', patch)
  },
  install: {
    node: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('install:node'),
    openclaw: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('install:openclaw'),
    onStatus: (
      cb: (status: { percent: number; stage: string; detail?: string }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        status: { percent: number; stage: string; detail?: string }
      ): void => cb(status)
      ipcRenderer.on('install:status', handler)
      return () => ipcRenderer.removeListener('install:status', handler)
    },
    onProgress: (cb: (msg: string) => void): (() => void) => {
      const handler = (_: unknown, msg: string): void => cb(msg)
      ipcRenderer.on('install:progress', handler)
      return () => ipcRenderer.removeListener('install:progress', handler)
    },
    onError: (cb: (msg: string) => void): (() => void) => {
      const handler = (_: unknown, msg: string): void => cb(msg)
      ipcRenderer.on('install:error', handler)
      return () => ipcRenderer.removeListener('install:error', handler)
    }
  },
  terminal: {
    onOutput: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_: unknown, chunk: string): void => cb(chunk)
      ipcRenderer.on('terminal:output', handler)
      return () => ipcRenderer.removeListener('terminal:output', handler)
    },
    onExit: (cb: (result: { success: boolean; code: number | null }) => void): (() => void) => {
      const handler = (_: unknown, result: { success: boolean; code: number | null }): void =>
        cb(result)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    }
  },
  onboard: {
    channelOnly: (config: {
      channelType?: 'feishu' | 'wechat' | 'telegram'
      channelSetupMode?: 'one-click' | 'manual'
      telegramBotToken?: string
      feishuAppId?: string
      feishuAppSecret?: string
    }): Promise<{ success: boolean; error?: string; botUsername?: string }> =>
      ipcRenderer.invoke('onboard:channel-only', config),
    run: (config: {
      provider:
        | 'modelfamily'
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
    }): Promise<{ success: boolean; error?: string; botUsername?: string }> =>
      ipcRenderer.invoke('onboard:run', config)
  },
  oauth: {
    loginCodex: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('oauth:openai-codex')
  },
  reboot: (): void => ipcRenderer.send('system:reboot'),
  gateway: {
    start: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('gateway:start'),
    stop: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('gateway:stop'),
    restart: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('gateway:restart'),
    status: (): Promise<'running' | 'stopped'> => ipcRenderer.invoke('gateway:status'),
    onLog: (cb: (msg: string) => void): (() => void) => {
      const handler = (_: unknown, msg: string): void => cb(msg)
      ipcRenderer.on('gateway:log', handler)
      return () => ipcRenderer.removeListener('gateway:log', handler)
    },
    onStatusChanged: (cb: (status: 'running' | 'stopped') => void): (() => void) => {
      const handler = (_: unknown, s: 'running' | 'stopped'): void => cb(s)
      ipcRenderer.on('gateway:status-changed', handler)
      return () => ipcRenderer.removeListener('gateway:status-changed', handler)
    }
  },
  troubleshoot: {
    checkPort: (): Promise<{ inUse: boolean; pid?: string }> =>
      ipcRenderer.invoke('troubleshoot:check-port'),
    doctorFix: (): Promise<{ success: boolean }> => ipcRenderer.invoke('troubleshoot:doctor-fix'),
    aiRepairPlan: (payload?: {
      logs?: string[]
    }): Promise<{
      success: boolean
      summary: string
      source: 'ai' | 'fallback'
      actions: Array<{
        type:
          | 'doctor_fix'
          | 'disable_memory_search'
          | 'set_gateway_mode_local'
          | 'restart_gateway'
          | 'run_command'
        label: string
        reason: string
        effect: string
        commandPreview: string
        commandRuntime: string
        approval: 'auto' | 'confirm'
      }>
      requiresApproval: boolean
      planId?: string
      error?: string
    }> => ipcRenderer.invoke('troubleshoot:ai-repair-plan', payload),
    aiRepairExecute: (payload: {
      planId: string
    }): Promise<{
      success: boolean
      summary: string
      actions: string[]
      error?: string
      roundsCompleted?: number
      awaitingApproval?: {
        planId: string
        summary: string
        source: 'ai' | 'fallback'
        actions: Array<{
          type:
            | 'doctor_fix'
            | 'disable_memory_search'
            | 'set_gateway_mode_local'
            | 'restart_gateway'
            | 'run_command'
          label: string
          reason: string
          effect: string
          commandPreview: string
          commandRuntime: string
          approval: 'auto' | 'confirm'
        }>
      }
    }> =>
      ipcRenderer.invoke('troubleshoot:ai-repair-execute', payload),
    aiRepair: (payload?: {
      logs?: string[]
    }): Promise<{ success: boolean; summary: string; actions: string[]; error?: string }> =>
      ipcRenderer.invoke('troubleshoot:ai-repair', payload)
  },
  wsl: {
    check: (): Promise<
      'not_available' | 'not_installed' | 'needs_reboot' | 'no_distro' | 'not_initialized' | 'ready'
    > => ipcRenderer.invoke('wsl:check'),
    install: (
      prevState?: string
    ): Promise<{ success: boolean; needsReboot?: boolean; state?: string; error?: string }> =>
      ipcRenderer.invoke('wsl:install', prevState)
  },
  wizard: {
    saveState: (state: {
      step: string
      wslInstalled: boolean
      timestamp: number
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('wizard:save-state', state),
    loadState: (): Promise<{
      step: string
      wslInstalled: boolean
      timestamp: number
    } | null> => ipcRenderer.invoke('wizard:load-state'),
    clearState: (): Promise<{ success: boolean }> => ipcRenderer.invoke('wizard:clear-state')
  },
  newsletter: {
    subscribe: (email: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('newsletter:subscribe', email)
  },
  update: {
    check: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:check'),
    download: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:download'),
    install: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:install'),
    onAvailable: (cb: (info: { version: string }) => void): (() => void) => {
      const handler = (_: unknown, info: { version: string }): void => cb(info)
      ipcRenderer.on('update:available', handler)
      return () => ipcRenderer.removeListener('update:available', handler)
    },
    onProgress: (cb: (percent: number) => void): (() => void) => {
      const handler = (_: unknown, p: number): void => cb(p)
      ipcRenderer.on('update:progress', handler)
      return () => ipcRenderer.removeListener('update:progress', handler)
    },
    onDownloaded: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('update:downloaded', handler)
      return () => ipcRenderer.removeListener('update:downloaded', handler)
    },
    onError: (cb: (msg: string) => void): (() => void) => {
      const handler = (_: unknown, msg: string): void => cb(msg)
      ipcRenderer.on('update:error', handler)
      return () => ipcRenderer.removeListener('update:error', handler)
    }
  },
  config: {
    read: (): Promise<{
      success: boolean
      config: {
        provider?: string
        model?: string
        hasChannel?: boolean
        channelType?: 'feishu' | 'wechat' | 'telegram'
        memorySearch?: {
          enabled: boolean
          provider?: 'openai' | 'gemini'
        }
        hasCredentials?: boolean
        gatewayMode?: string
        isConfigured?: boolean
        issues?: string[]
      } | null
      error?: string
    }> => ipcRenderer.invoke('config:read'),
    validateApiKey: (config: {
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
    }): Promise<{ success: boolean; error?: string; warning?: string }> =>
      ipcRenderer.invoke('config:validate-api-key', config),
    switchProvider: (config: {
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
    }): Promise<{ success: boolean; error?: string; warning?: string }> =>
      ipcRenderer.invoke('config:switch-provider', config)
  },
  openclaw: {
    checkUpdate: (): Promise<{ currentVersion: string | null; latestVersion: string | null }> =>
      ipcRenderer.invoke('openclaw:check-update'),
    dashboard: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('openclaw:dashboard'),
    updateChannel: (
      channelType: 'telegram',
      channelConfig: { botToken: string }
    ): Promise<{ success: boolean; error?: string; botUsername?: string }> =>
      ipcRenderer.invoke('openclaw:update-channel', channelType, channelConfig),
    cleanUninstall: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('openclaw:clean-uninstall')
  },
  autoLaunch: {
    get: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke('autolaunch:get'),
    set: (enabled: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('autolaunch:set', enabled)
  },
  uninstall: {
    openclaw: (opts: { removeConfig: boolean }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('uninstall:openclaw', opts),
    onProgress: (cb: (msg: string) => void): (() => void) => {
      const handler = (_: unknown, msg: string): void => cb(msg)
      ipcRenderer.on('uninstall:progress', handler)
      return () => ipcRenderer.removeListener('uninstall:progress', handler)
    }
  },
  backup: {
    export: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('backup:export'),
    import: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('backup:import')
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
