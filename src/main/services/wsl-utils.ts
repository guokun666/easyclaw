import { spawn } from 'child_process'
import { platform } from 'os'
import { isIgnorableWslWarningLine } from './terminal-output'

export type WslState =
  | 'not_available'
  | 'not_installed'
  | 'needs_reboot'
  | 'no_distro'
  | 'not_initialized'
  | 'ready'

/** Progression order of WSL states (used for before/after comparison) */
export const WSL_STATE_ORDER: readonly WslState[] = [
  'not_available',
  'not_installed',
  'needs_reboot',
  'no_distro',
  'not_initialized',
  'ready'
] as const

const WSL_DISTRO = 'Ubuntu'
const WSL_USER = 'root'
const INTERNET_SETTINGS_REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

interface ProxyTarget {
  scheme: string
  host: string
  port: string
}

interface ProxyConfig {
  http?: ProxyTarget
  https?: ProxyTarget
  all?: ProxyTarget
}

export interface WslProxyRuntimeInfo {
  enabled: boolean
  displayValue?: string
  needsAutoBridge: boolean
}

let windowsProxyConfigPromise: Promise<ProxyConfig | null> | null = null

const isLocalhostHost = (host: string): boolean =>
  ['127.0.0.1', 'localhost', '::1'].includes(host.trim().toLowerCase())

const formatProxyTarget = (target?: ProxyTarget): string | undefined => {
  if (!target) return undefined
  return `${target.host}:${target.port}`
}

const parseProxyTarget = (value: string): ProxyTarget | null => {
  const trimmed = value.trim()
  if (!trimmed) return null

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  try {
    const url = new URL(withScheme)
    if (!url.hostname || !url.port) return null
    return {
      scheme: url.protocol.replace(/:$/, '') || 'http',
      host: url.hostname,
      port: url.port
    }
  } catch {
    return null
  }
}

const parseProxyServer = (raw: string): ProxyConfig | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (!trimmed.includes('=')) {
    const target = parseProxyTarget(trimmed)
    if (!target) return null
    return { http: target, https: target, all: target }
  }

  const config: ProxyConfig = {}

  for (const segment of trimmed.split(';')) {
    const [rawKey, rawValue] = segment.split('=', 2)
    if (!rawKey || !rawValue) continue
    const target = parseProxyTarget(rawValue)
    if (!target) continue

    const key = rawKey.trim().toLowerCase()
    if (key === 'http') config.http = target
    if (key === 'https') config.https = target
    if (key === 'socks') config.all = target
  }

  if (!config.http && config.https) config.http = config.https
  if (!config.https && config.http) config.https = config.http
  if (!config.all && config.http) config.all = config.http

  return config.http || config.https || config.all ? config : null
}

const readWindowsSystemProxy = async (): Promise<ProxyConfig | null> => {
  if (platform() !== 'win32') return null

  if (!windowsProxyConfigPromise) {
    windowsProxyConfigPromise = new Promise((resolve) => {
      const child = spawn('reg', ['query', INTERNET_SETTINGS_REG_PATH], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })

      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })

      child.on('close', () => {
        const enabledMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i)
        const enabled = enabledMatch ? parseInt(enabledMatch[1], 16) !== 0 : false
        if (!enabled) {
          resolve(null)
          return
        }
        const valueMatch = output.match(/ProxyServer\s+REG_\w+\s+(.+)$/m)
        resolve(valueMatch ? parseProxyServer(valueMatch[1]) : null)
      })
      child.on('error', () => resolve(null))
    })
  }

  return windowsProxyConfigPromise
}

const buildWslProxyPreamble = async (): Promise<string> => {
  const proxyConfig = await readWindowsSystemProxy()
  if (!proxyConfig) return ''

  const localTargets = [proxyConfig.http, proxyConfig.https, proxyConfig.all].filter(
    (target): target is ProxyTarget => !!target && isLocalhostHost(target.host)
  )
  if (localTargets.length === 0) return ''

  const hostResolver =
    'EASYCLAW_HOST_IP="$(awk \'/^nameserver[[:space:]]+/ { print $2; exit }\' /etc/resolv.conf 2>/dev/null)"; ' +
    'if [ -z "$EASYCLAW_HOST_IP" ]; then EASYCLAW_HOST_IP="$(ip route show default 2>/dev/null | awk \'/default/ { print $3; exit }\')"; fi; ' +
    'if [ -n "$EASYCLAW_HOST_IP" ]; then '

  const exports: string[] = []

  const pushExport = (name: string, target?: ProxyTarget): void => {
    if (!target || !isLocalhostHost(target.host)) return
    exports.push(`export ${name}="${target.scheme}://$EASYCLAW_HOST_IP:${target.port}"`)
  }

  pushExport('HTTP_PROXY', proxyConfig.http)
  pushExport('http_proxy', proxyConfig.http)
  pushExport('HTTPS_PROXY', proxyConfig.https ?? proxyConfig.http)
  pushExport('https_proxy', proxyConfig.https ?? proxyConfig.http)
  pushExport('ALL_PROXY', proxyConfig.all ?? proxyConfig.http)
  pushExport('all_proxy', proxyConfig.all ?? proxyConfig.http)
  exports.push(
    'export NO_PROXY="127.0.0.1,localhost,::1"',
    'export no_proxy="127.0.0.1,localhost,::1"'
  )

  if (exports.length === 0) return ''

  return `${hostResolver}${exports.join('; ')}; fi; `
}

export const buildWslBashArgs = async (script: string): Promise<string[]> => {
  const proxyPreamble = await buildWslProxyPreamble()
  return ['-d', WSL_DISTRO, '-u', WSL_USER, '--', 'bash', '-lc', `${proxyPreamble}${script}`]
}

export const getWslProxyRuntimeInfo = async (): Promise<WslProxyRuntimeInfo> => {
  const proxyConfig = await readWindowsSystemProxy()
  if (!proxyConfig) {
    return {
      enabled: false,
      needsAutoBridge: false
    }
  }

  const primaryTarget = proxyConfig.http ?? proxyConfig.https ?? proxyConfig.all
  const displayValue = formatProxyTarget(primaryTarget)
  const needsAutoBridge = !!primaryTarget && isLocalhostHost(primaryTarget.host)

  return {
    enabled: true,
    displayValue,
    needsAutoBridge
  }
}

const runCmd = (cmd: string, args: string[], timeout = 15000): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('timeout'))
    }, timeout)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.replace(/\0/g, '').trim())
      else reject(new Error(stderr.replace(/\0/g, '') || `exit ${code}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

export const checkWslState = async (): Promise<WslState> => {
  // Check WSL availability (--version only supported on Store WSL)
  try {
    await runCmd('wsl', ['--version'])
  } catch {
    // Inbox WSL doesn't support --version → re-check by verifying wsl.exe exists
    try {
      await runCmd('where', ['wsl'])
    } catch {
      return 'not_available'
    }
  }

  // Check if reboot is needed via wsl --status
  try {
    const status = await runCmd('wsl', ['--status'])
    if (status.includes('reboot') || status.includes('restart') || status.includes('재부팅')) {
      return 'needs_reboot'
    }
  } catch {
    // Reboot may be needed if --status fails
    // Proceed with additional check via wsl --list
  }

  // Check if Ubuntu distro exists
  try {
    const list = await runCmd('wsl', ['--list', '--verbose'])
    if (!list.includes(WSL_DISTRO)) {
      return 'no_distro'
    }
    // Verify Ubuntu is registered and working properly
    try {
      await runCmd('wsl', ['-d', WSL_DISTRO, '-u', WSL_USER, '--', 'echo', 'ok'])
      return 'ready'
    } catch {
      return 'not_initialized'
    }
  } catch {
    // --list failed → WSL installed but not yet initialized
    return 'not_installed'
  }
}

/** Run command via bash -lc inside WSL Ubuntu (auto-loads nvm PATH) */
export const runInWsl = async (script: string, timeout = 30000): Promise<string> => {
  const args = await buildWslBashArgs(script)

  return new Promise((resolve, reject) => {
    const child = spawn('wsl', args)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('timeout'))
    }, timeout)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      const cleanStderr = stderr
        .replace(/\0/g, '')
        .split(/\r\n|\n|\r/)
        .filter((line) => !isIgnorableWslWarningLine(line))
        .join('\n')
        .trim()
      if (code === 0) resolve(stdout.replace(/\0/g, '').trim())
      else reject(new Error(cleanStderr || `exit ${code}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Read file inside WSL */
export const readWslFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('wsl', ['-d', WSL_DISTRO, '-u', WSL_USER, '--', 'cat', path])
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Timeout reading ${path}`))
    }, 10000)
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`Failed to read ${path}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

/** Write file inside WSL */
export const writeWslFile = (path: string, content: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('wsl', ['-d', WSL_DISTRO, '-u', WSL_USER, '--', 'tee', path])
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Timeout writing ${path}`))
    }, 10000)
    child.stdout.resume() // Consume tee stdout to prevent buffer hang
    child.stdin.write(content, () => child.stdin.end())
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Failed to write ${path}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
