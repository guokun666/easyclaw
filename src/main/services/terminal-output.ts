import { spawn } from 'child_process'
import { platform } from 'os'
import { TextDecoder } from 'util'

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const CJK_PATTERN = /[\u3400-\u9fff]/g
const LATIN_SUPPLEMENT_PATTERN = /[\u00c0-\u024f]/g

const WINDOWS_CODE_PAGE_ENCODINGS: Record<string, string> = {
  '65001': 'utf-8',
  '54936': 'gb18030',
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
  '936': 'gbk',
  '950': 'big5',
  '932': 'shift_jis',
  '949': 'euc-kr'
}

let windowsTerminalEncodingPromise: Promise<string> | null = null

const countMatches = (value: string, pattern: RegExp): number => value.match(pattern)?.length ?? 0

const normalizeTerminalText = (value: string): string =>
  value.replace(ANSI_PATTERN, '').replace(/\u0000/g, '')

const shouldPreferFallbackText = (utf8Text: string, fallbackText: string): boolean => {
  const cleanUtf8 = normalizeTerminalText(utf8Text)
  const cleanFallback = normalizeTerminalText(fallbackText)

  const utf8ReplacementCount = countMatches(cleanUtf8, /\uFFFD/g)
  const fallbackReplacementCount = countMatches(cleanFallback, /\uFFFD/g)
  if (utf8ReplacementCount > fallbackReplacementCount) return true

  const utf8CjkCount = countMatches(cleanUtf8, CJK_PATTERN)
  const fallbackCjkCount = countMatches(cleanFallback, CJK_PATTERN)
  const utf8LatinSupplementCount = countMatches(cleanUtf8, LATIN_SUPPLEMENT_PATTERN)

  return (
    utf8CjkCount === 0 &&
    fallbackCjkCount >= utf8CjkCount + 2 &&
    utf8LatinSupplementCount >= 2
  )
}

export const getWindowsTerminalEncoding = async (): Promise<string> => {
  if (platform() !== 'win32') return 'utf-8'

  if (!windowsTerminalEncodingPromise) {
    windowsTerminalEncodingPromise = new Promise((resolve) => {
      const child = spawn('cmd', ['/d', '/s', '/c', 'chcp'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })

      let output = ''

      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('ascii')
      })

      const resolveEncoding = (): void => {
        const codePage = output.match(/(\d{3,5})/)?.[1]
        resolve((codePage && WINDOWS_CODE_PAGE_ENCODINGS[codePage]) || 'utf-8')
      }

      child.on('close', resolveEncoding)
      child.on('error', () => resolve('utf-8'))
    })
  }

  return windowsTerminalEncodingPromise
}

export interface TerminalLineEmitter {
  push: (chunk: Buffer) => void
  flush: () => void
}

export const createTerminalLineEmitter = async (
  onLine: (line: string) => void
): Promise<TerminalLineEmitter> => {
  const fallbackEncoding = await getWindowsTerminalEncoding()
  const utf8Decoder = new TextDecoder('utf-8')
  const fallbackDecoder =
    platform() === 'win32' && fallbackEncoding !== 'utf-8'
      ? new TextDecoder(fallbackEncoding)
      : null

  let pending = ''

  const emitText = (text: string): void => {
    const normalized = normalizeTerminalText(text).replace(/\r/g, '')
    const chunks = (pending + normalized).split(/\r\n|\n|\r/)
    pending = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const line = chunk.trimEnd()
      if (line.trim()) onLine(line)
    }
  }

  return {
    push: (chunk: Buffer): void => {
      const utf8Text = utf8Decoder.decode(chunk, { stream: true })
      const fallbackText = fallbackDecoder?.decode(chunk, { stream: true }) ?? ''
      emitText(
        fallbackDecoder && shouldPreferFallbackText(utf8Text, fallbackText) ? fallbackText : utf8Text
      )
    },
    flush: (): void => {
      const utf8Text = utf8Decoder.decode()
      const fallbackText = fallbackDecoder?.decode() ?? ''
      emitText(
        fallbackDecoder && shouldPreferFallbackText(utf8Text, fallbackText) ? fallbackText : utf8Text
      )

      const line = pending.trimEnd()
      if (line.trim()) onLine(line)
      pending = ''
    }
  }
}
