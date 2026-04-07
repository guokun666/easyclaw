import { spawn } from 'child_process'
import { platform } from 'os'
import { checkWslState, runInWsl, getWslProxyRuntimeInfo, type WslState } from './wsl-utils'
import { getLatestPackageVersion } from './install-sources'
import { getPathEnv, resolvePreferredBin } from './path-utils'
import { getManagedNpmEnv } from './npm-paths'

export interface EnvCheckResult {
  os: 'macos' | 'windows' | 'linux'
  nodeInstalled: boolean
  nodeVersion: string | null
  nodeVersionOk: boolean
  openclawInstalled: boolean
  openclawVersion: string | null
  openclawLatestVersion: string | null
  wslState?: WslState
  wslProxyInfo?: {
    enabled: boolean
    displayValue?: string
    needsAutoBridge: boolean
  }
}

type CommandRunner = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>

const runCommand: CommandRunner = (cmd, args, env = getPathEnv()): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('timeout after 15000ms'))
    }, 15000)

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr || `exit code ${code}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

const parseVersion = (raw: string): string | null => {
  const match = raw.match(/v?(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

const semverGte = (version: string, min: string): boolean => {
  const [a1, a2, a3] = version.split('.').map(Number)
  const [b1, b2, b3] = min.split('.').map(Number)
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  return a3 >= b3
}

const fetchOpenclawLatestVersion = async (): Promise<string | null> => {
  return getLatestPackageVersion('openclaw')
}

const getOpenclawVersion = async (
  run: CommandRunner,
  envCandidates?: Array<NodeJS.ProcessEnv | undefined>
): Promise<string | null> => {
  const openclawBin = resolvePreferredBin('openclaw')
  const candidates =
    envCandidates && envCandidates.length > 0
      ? envCandidates
      : [undefined as NodeJS.ProcessEnv | undefined]

  for (const env of candidates) {
    try {
      // A broken npm install can still appear in `npm list -g`, so require the CLI
      // to execute a harmless help command before treating OpenClaw as installed.
      await run(openclawBin, ['doctor', '--help'], env)
    } catch {
      continue
    }

    try {
      const raw = await run(openclawBin, ['--version'], env)
      const version = parseVersion(raw)
      if (version) return version
    } catch {
      /* try next candidate */
    }
  }

  return null
}

const checkNodeAndOpenclaw = async (
  run: CommandRunner,
  envCandidates?: Array<NodeJS.ProcessEnv | undefined>
): Promise<{
  nodeInstalled: boolean
  nodeVersion: string | null
  nodeVersionOk: boolean
  openclawInstalled: boolean
  openclawVersion: string | null
}> => {
  let nodeVersion: string | null = null
  let nodeInstalled = false
  let nodeVersionOk = false
  let openclawInstalled = false
  let openclawVersion: string | null = null

  try {
    const raw = await run('node', ['--version'], envCandidates?.[0])
    nodeVersion = parseVersion(raw)
    nodeInstalled = nodeVersion !== null
    nodeVersionOk = nodeVersion ? semverGte(nodeVersion, '22.16.0') : false
  } catch {
    /* not installed */
  }

  openclawVersion = await getOpenclawVersion(run, envCandidates)
  if (openclawVersion) {
    openclawInstalled = true
  }

  return { nodeInstalled, nodeVersion, nodeVersionOk, openclawInstalled, openclawVersion }
}

export interface OpenclawUpdateInfo {
  currentVersion: string | null
  latestVersion: string | null
}

export const checkOpenclawUpdate = async (): Promise<OpenclawUpdateInfo> => {
  const os = platform() === 'win32' ? 'windows' : 'other'

  const getCurrentVersion = async (): Promise<string | null> => {
    try {
      if (os === 'windows') {
        const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
        const wslRun: CommandRunner = (cmd, args): Promise<string> =>
          runInWsl(`${cmd} ${args.map(shellEscape).join(' ')}`)
        return getOpenclawVersion(wslRun)
      } else {
        const baseEnv = getPathEnv()
        const managedEnv = getManagedNpmEnv(baseEnv)
        return getOpenclawVersion(runCommand, [managedEnv, baseEnv])
      }
    } catch {
      return null
    }
  }

  const getLatestVersion = async (): Promise<string | null> => {
    try {
      return await fetchOpenclawLatestVersion()
    } catch {
      return null
    }
  }

  const [currentVersion, latestVersion] = await Promise.all([
    getCurrentVersion(),
    getLatestVersion()
  ])

  return { currentVersion, latestVersion }
}

export const checkEnvironment = async (): Promise<EnvCheckResult> => {
  const os = platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : 'linux'

  let wslState: WslState | undefined
  let nodeInstalled = false
  let nodeVersion: string | null = null
  let nodeVersionOk = false
  let openclawInstalled = false
  let openclawVersion: string | null = null
  let wslProxyInfo:
    | {
        enabled: boolean
        displayValue?: string
        needsAutoBridge: boolean
      }
    | undefined

  if (os === 'windows') {
    // Windows: check WSL state, then check Node.js/OpenClaw inside WSL if ready
    wslState = await checkWslState()
    wslProxyInfo = await getWslProxyRuntimeInfo()

    if (wslState === 'ready') {
      const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
      const wslRun: CommandRunner = (cmd, args): Promise<string> =>
        runInWsl(`${cmd} ${args.map(shellEscape).join(' ')}`)

      const result = await checkNodeAndOpenclaw(wslRun)
      nodeInstalled = result.nodeInstalled
      nodeVersion = result.nodeVersion
      nodeVersionOk = result.nodeVersionOk
      openclawInstalled = result.openclawInstalled
      openclawVersion = result.openclawVersion
    }
    // Keep all false if wslState !== 'ready'
  } else {
    // macOS / Linux
    const baseEnv = getPathEnv()
    const managedEnv = getManagedNpmEnv(baseEnv)
    const result = await checkNodeAndOpenclaw(runCommand, [managedEnv, baseEnv])
    nodeInstalled = result.nodeInstalled
    nodeVersion = result.nodeVersion
    nodeVersionOk = result.nodeVersionOk
    openclawInstalled = result.openclawInstalled
    openclawVersion = result.openclawVersion
  }

  let openclawLatestVersion: string | null = null

  try {
    openclawLatestVersion = await fetchOpenclawLatestVersion()
  } catch {
    /* network error — skip */
  }

  return {
    os,
    nodeInstalled,
    nodeVersion,
    nodeVersionOk,
    openclawInstalled,
    openclawVersion,
    openclawLatestVersion,
    wslState,
    wslProxyInfo
  }
}
