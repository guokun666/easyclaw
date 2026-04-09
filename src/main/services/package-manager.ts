import { spawn } from 'child_process'
import { platform } from 'os'
import { getManagedNpmEnv } from './npm-paths'
import { getPathEnv, resolvePreferredBin } from './path-utils'
import { getNpmCommandEnv, getPnpmPackageCandidates } from './install-sources'
import { runInWsl } from './wsl-utils'

type LogFn = (msg: string) => void

const PNPM_CHECK_TIMEOUT_MS = 15000
const PNPM_INSTALL_TIMEOUT_MS = 120000
const OPENCLAW_HOISTED_NODE_LINKER = 'hoisted'
const OPENCLAW_ALLOW_BUILD_PACKAGES = [
  'openclaw',
  'sharp',
  'protobufjs',
  '@matrix-org/matrix-sdk-crypto-nodejs',
  'koffi'
] as const

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const isOpenClawPackageSpec = (packageSpec: string): boolean =>
  packageSpec === 'openclaw' || packageSpec.startsWith('openclaw@')

const getOpenClawGlobalAddArgs = (): string[] => [
  `--config.node-linker=${OPENCLAW_HOISTED_NODE_LINKER}`,
  ...OPENCLAW_ALLOW_BUILD_PACKAGES.flatMap((packageName) => ['--allow-build', packageName])
]

const canRunHostCommand = (cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env })
    child.stdout.resume()
    child.stderr.resume()
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })

const runHostCommand = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = PNPM_INSTALL_TIMEOUT_MS
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env })
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout after ${timeout}ms`))
    }, timeout)

    child.stdout.resume()
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `exit ${code}`))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

const hasManagedPnpmOnHost = async (): Promise<boolean> => {
  const env = getManagedNpmEnv(getPathEnv())
  const pnpm = resolvePreferredBin('pnpm')
  return canRunHostCommand(pnpm, ['--version'], env)
}

const ensurePnpmOnHost = async (onLog: LogFn = () => {}): Promise<void> => {
  if (await hasManagedPnpmOnHost()) return

  const npm = resolvePreferredBin('npm')
  const baseEnv = getManagedNpmEnv(getPathEnv())
  let lastError: Error | null = null

  for (const candidate of getPnpmPackageCandidates()) {
    try {
      onLog(`Package manager source candidate: ${candidate.label}`)
      await runHostCommand(
        npm,
        ['install', '-g', candidate.packageName],
        getNpmCommandEnv(candidate.registry, baseEnv)
      )
      onLog(`Package manager source selected: ${candidate.label}`)
      if (await hasManagedPnpmOnHost()) return
      lastError = new Error(`pnpm is still unavailable after using ${candidate.label}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      onLog(`Package manager source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All package manager sources failed')
}

const hasPnpmInWsl = async (): Promise<boolean> => {
  try {
    await runInWsl(
      'command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1',
      PNPM_CHECK_TIMEOUT_MS
    )
    return true
  } catch {
    return false
  }
}

const ensurePnpmInWsl = async (onLog: LogFn = () => {}): Promise<void> => {
  if (await hasPnpmInWsl()) return

  let lastError: Error | null = null

  for (const candidate of getPnpmPackageCandidates()) {
    try {
      onLog(`Package manager source candidate: ${candidate.label}`)
      await runInWsl(
        `npm_config_registry=${shellEscape(candidate.registry)} npm install -g ${shellEscape(candidate.packageName)}`,
        PNPM_INSTALL_TIMEOUT_MS
      )
      onLog(`Package manager source selected: ${candidate.label}`)
      if (await hasPnpmInWsl()) return
      lastError = new Error(`pnpm is still unavailable after using ${candidate.label}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      onLog(`Package manager source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All package manager sources failed')
}

export const ensurePackageManagerAvailable = async (onLog?: LogFn): Promise<void> => {
  if (platform() === 'win32') {
    await ensurePnpmInWsl(onLog)
    return
  }

  await ensurePnpmOnHost(onLog)
}

export const getPackageManagerBin = (): string =>
  platform() === 'win32' ? 'pnpm' : resolvePreferredBin('pnpm')

export const getPackageManagerGlobalAddArgs = (packageSpec: string): string[] => {
  const args = ['add', '-g']

  // OpenClaw bundles runtime plugins that import optional provider dependencies
  // from the package root. pnpm's isolated linker breaks those imports for
  // commands like `openclaw status`, so force a hoisted global layout here.
  if (isOpenClawPackageSpec(packageSpec)) {
    args.push(...getOpenClawGlobalAddArgs())
  }

  args.push(packageSpec)
  return args
}

export const getPackageManagerGlobalAddPreview = (packageSpec: string): string =>
  `pnpm ${getPackageManagerGlobalAddArgs(packageSpec).join(' ')}`

export const buildPackageManagerGlobalAddCommand = (
  packageSpec: string,
  command = 'pnpm'
): string => [command, ...getPackageManagerGlobalAddArgs(packageSpec)].map(shellEscape).join(' ')

export const getPackageManagerGlobalRemoveArgs = (packageName: string): string[] => [
  'remove',
  '-g',
  packageName
]

export const getPackageManagerDlxArgs = (packageSpec: string, args: string[]): string[] => [
  'dlx',
  packageSpec,
  ...args
]
