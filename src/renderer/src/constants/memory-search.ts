import type { MemorySearchProvider } from '../../../shared/types/memory-search'

export interface MemorySearchProviderOption {
  id: MemorySearchProvider
  label: string
  placeholder: string
  pattern: RegExp
  defaultModel: string
}

export const memorySearchProviderOptions: MemorySearchProviderOption[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-...',
    pattern: /^sk-(?!ant-)/,
    defaultModel: 'text-embedding-3-small'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    placeholder: 'AIza...',
    pattern: /^AIza/,
    defaultModel: 'gemini-embedding-001'
  }
]

export const memorySearchProviderMap = Object.fromEntries(
  memorySearchProviderOptions.map((option) => [option.id, option])
) as Record<MemorySearchProvider, MemorySearchProviderOption>
