import type {
  MemorySearchConfigPayload,
  MemorySearchProvider
} from '../../../shared/types/memory-search'
import type { Provider } from './providers'

export type ChannelSetupMode = 'one-click' | 'manual'

export interface ConfigDraft {
  apiKey: string
  telegramBotToken: string
  feishuSetupMode: ChannelSetupMode
  feishuAppId: string
  feishuAppSecret: string
  memorySearchEnabled: boolean
  memorySearchProvider: MemorySearchProvider
  memorySearchApiKey: string
  memorySearchNoticeTone: 'idle' | 'success' | 'warning'
  memorySearchNotice: string | null
  oauthDone: boolean
  validatedApiKey: string | null
  apiKeyTestState: 'idle' | 'success' | 'warning' | 'error'
  apiKeyTestMessage: string | null
}

export const EMPTY_CONFIG_DRAFT: ConfigDraft = {
  apiKey: '',
  telegramBotToken: '',
  feishuSetupMode: 'one-click',
  feishuAppId: '',
  feishuAppSecret: '',
  memorySearchEnabled: false,
  memorySearchProvider: 'openai',
  memorySearchApiKey: '',
  memorySearchNoticeTone: 'idle',
  memorySearchNotice: null,
  oauthDone: false,
  validatedApiKey: null,
  apiKeyTestState: 'idle',
  apiKeyTestMessage: null
}

export interface SetupPayload {
  provider: Provider
  apiKey?: string
  authMethod?: 'api-key' | 'oauth'
  skipChannelConfig?: boolean
  channelType?: 'feishu' | 'wechat' | 'telegram'
  channelSetupMode?: ChannelSetupMode
  telegramBotToken?: string
  feishuAppId?: string
  feishuAppSecret?: string
  modelId?: string
  memorySearch?: MemorySearchConfigPayload
}
