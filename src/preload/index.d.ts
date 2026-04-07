type WslState =
  | 'not_available'
  | 'not_installed'
  | 'needs_reboot'
  | 'no_distro'
  | 'not_initialized'
  | 'ready'

interface WizardPersistedState {
  step: string
  wslInstalled: boolean
  timestamp: number
}

interface ElectronAPI {
  version: () => Promise<string>
  env: {
    check: () => Promise<{
      os: 'macos' | 'windows' | 'linux'
      nodeInstalled: boolean
      nodeVersion: string | null
      nodeVersionOk: boolean
      openclawInstalled: boolean
      openclawVersion: string | null
      openclawLatestVersion: string | null
      freshInstallerLaunch?: boolean
      wslState?: WslState
      wslProxyInfo?: {
        enabled: boolean
        displayValue?: string
        needsAutoBridge: boolean
      }
    }>
  }
  settings: {
    getInstallSources: () => Promise<{
      sourceMode: 'auto' | 'official' | 'mirror'
    }>
    setInstallSources: (patch: {
      sourceMode?: 'auto' | 'official' | 'mirror'
    }) => Promise<{ success: boolean }>
  }
  install: {
    node: () => Promise<{ success: boolean; error?: string }>
    openclaw: () => Promise<{ success: boolean; error?: string }>
    cancel: () => Promise<{ success: boolean; cancelled: boolean }>
    onStatus: (
      cb: (status: { percent: number; stage: string; detail?: string }) => void
    ) => () => void
    onProgress: (cb: (msg: string) => void) => () => void
    onError: (cb: (msg: string) => void) => () => void
  }
  terminal: {
    onOutput: (cb: (chunk: string) => void) => () => void
    onExit: (cb: (result: { success: boolean; code: number | null }) => void) => () => void
  }
  onboard: {
    channelOnly: (config: {
      channelType?: 'feishu' | 'wechat' | 'telegram'
      channelSetupMode?: 'one-click' | 'manual'
      telegramBotToken?: string
      feishuAppId?: string
      feishuAppSecret?: string
    }) => Promise<{ success: boolean; error?: string; botUsername?: string }>
    run: (config: {
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
    }) => Promise<{ success: boolean; error?: string; botUsername?: string }>
  }
  oauth: {
    loginCodex: () => Promise<{ success: boolean; error?: string }>
  }
  reboot: () => void
  gateway: {
    start: () => Promise<{ success: boolean; error?: string }>
    stop: () => Promise<{ success: boolean; error?: string }>
    restart: () => Promise<{ success: boolean; error?: string }>
    status: () => Promise<'running' | 'stopped'>
    onLog: (cb: (msg: string) => void) => () => void
    onStatusChanged: (cb: (status: 'running' | 'stopped') => void) => () => void
  }
  troubleshoot: {
    checkPort: () => Promise<{ inUse: boolean; pid?: string }>
    doctorFix: () => Promise<{ success: boolean }>
    aiRepairPlan: (payload?: {
      logs?: string[]
    }) => Promise<{
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
    }>
    aiRepairExecute: (payload: {
      planId: string
    }) => Promise<{
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
    }>
    aiRepair: (payload?: {
      logs?: string[]
    }) => Promise<{ success: boolean; summary: string; actions: string[]; error?: string }>
  }
  wsl: {
    check: () => Promise<WslState>
    install: (
      prevState?: WslState
    ) => Promise<{ success: boolean; needsReboot?: boolean; state?: WslState; error?: string }>
  }
  wizard: {
    saveState: (state: WizardPersistedState) => Promise<{ success: boolean }>
    loadState: () => Promise<WizardPersistedState | null>
    clearState: () => Promise<{ success: boolean }>
  }
  newsletter: {
    subscribe: (email: string) => Promise<{ success: boolean }>
  }
  update: {
    check: () => Promise<{ success: boolean }>
    download: () => Promise<{ success: boolean }>
    install: () => Promise<{ success: boolean }>
    onAvailable: (cb: (info: { version: string }) => void) => () => void
    onProgress: (cb: (percent: number) => void) => () => void
    onDownloaded: (cb: () => void) => () => void
    onError: (cb: (msg: string) => void) => () => void
  }
  config: {
    read: () => Promise<{
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
    }>
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
    }) => Promise<{ success: boolean; error?: string; warning?: string }>
    switchProvider: (config: {
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
      modelId?: string
      memorySearch?: {
        enabled?: boolean
        provider?: 'openai' | 'gemini'
        apiKey?: string
      }
    }) => Promise<{ success: boolean; error?: string; warning?: string }>
  }
  openclaw: {
    checkUpdate: () => Promise<{ currentVersion: string | null; latestVersion: string | null }>
    dashboard: () => Promise<{ success: boolean; error?: string }>
    updateChannel: (
      channelType: 'telegram',
      channelConfig: { botToken: string }
    ) => Promise<{ success: boolean; error?: string; botUsername?: string }>
    cleanUninstall: () => Promise<{ success: boolean; error?: string }>
  }
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>
    set: (enabled: boolean) => Promise<{ success: boolean }>
  }
  uninstall: {
    openclaw: (opts: {
      removeConfig: boolean
      unregisterWsl?: boolean
    }) => Promise<{ success: boolean; error?: string }>
    onProgress: (cb: (msg: string) => void) => () => void
  }
  backup: {
    export: () => Promise<{ success: boolean; error?: string }>
    import: () => Promise<{ success: boolean; error?: string }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
