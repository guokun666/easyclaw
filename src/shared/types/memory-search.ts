export type MemorySearchProvider = 'openai' | 'gemini'

export interface MemorySearchConfigPayload {
  enabled?: boolean
  provider?: MemorySearchProvider
  apiKey?: string
}

export interface CurrentMemorySearchConfig {
  enabled: boolean
  provider?: MemorySearchProvider
}
