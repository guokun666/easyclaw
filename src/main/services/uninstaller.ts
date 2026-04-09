import { spawn } from 'child_process'
import { rm } from 'fs/promises'
import { homedir, platform } from 'os'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { stopGateway } from './gateway'
import { getPathEnv, resolvePreferredBin } from './path-utils'
import { getManagedNpmEnv, getManagedNpmPaths } from './npm-paths'
import { runInWsl, unregisterWslDistro } from './wsl-utils'
import { t } from '../../shared/i18n/main'

type ProgressCallback = (msg: string) => void

const runCommand = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 20000
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout after ${timeout}ms`))
    }, timeout)

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => (stdout += data.toString()))
    child.stderr.on('data', (data) => (stderr += data.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout.trim())
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `exit code ${code}`))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

const tryRunCommand = async (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout?: number
): Promise<string | null> => {
  try {
    return await runCommand(cmd, args, env, timeout)
  } catch {
    return null
  }
}

const removePaths = async (paths: Array<string | null | undefined>): Promise<void> => {
  for (const path of paths) {
    if (!path) continue
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

const sendProgress = (win: BrowserWindow, msg: string): void => {
  try {
    win.webContents.send('uninstall:progress', msg)
  } catch {
    /* window destroyed */
  }
}

const cleanupManagedInstallArtifacts = async (): Promise<void> => {
  const { prefixDir } = getManagedNpmPaths()
  await removePaths([prefixDir, '/usr/local/bin/openclaw'])
}

const cleanupNpmArtifacts = async (npmEnv: NodeJS.ProcessEnv): Promise<void> => {
  const npm = resolvePreferredBin('npm')
  const [prefixDir, rootDir] = await Promise.all([
    tryRunCommand(npm, ['prefix', '-g'], npmEnv),
    tryRunCommand(npm, ['root', '-g'], npmEnv)
  ])

  await removePaths([
    prefixDir ? join(prefixDir, 'bin', 'openclaw') : null,
    prefixDir ? join(prefixDir, 'bin', 'openclaw.cmd') : null,
    prefixDir ? join(prefixDir, 'bin', 'openclaw.ps1') : null,
    rootDir ? join(rootDir, 'openclaw') : null
  ])
}

const cleanupPnpmArtifacts = async (baseEnv: NodeJS.ProcessEnv): Promise<void> => {
  const pnpm = resolvePreferredBin('pnpm')
  const [binDir, rootDir] = await Promise.all([
    tryRunCommand(pnpm, ['bin', '-g'], baseEnv),
    tryRunCommand(pnpm, ['root', '-g'], baseEnv)
  ])

  await removePaths([
    binDir ? join(binDir, 'openclaw') : null,
    binDir ? join(binDir, 'openclaw.cmd') : null,
    binDir ? join(binDir, 'openclaw.ps1') : null,
    rootDir ? join(rootDir, 'openclaw') : null
  ])
}

const removeOpenClawHostPackage = async (): Promise<void> => {
  const baseEnv = getPathEnv()
  const managedEnv = getManagedNpmEnv(baseEnv)
  const npm = resolvePreferredBin('npm')
  const pnpm = resolvePreferredBin('pnpm')

  await tryRunCommand(npm, ['uninstall', '-g', 'openclaw'], managedEnv, 60000)
  await cleanupNpmArtifacts(managedEnv)
  await cleanupManagedInstallArtifacts()

  await tryRunCommand(npm, ['uninstall', '-g', 'openclaw'], baseEnv, 60000)
  await cleanupNpmArtifacts(baseEnv)

  await tryRunCommand(pnpm, ['remove', '-g', 'openclaw'], baseEnv, 60000)
  await tryRunCommand(pnpm, ['uninstall', '-g', 'openclaw'], baseEnv, 60000)
  await cleanupPnpmArtifacts(baseEnv)
}

const removeOpenClawWslPackage = async (): Promise<void> => {
  const script = [
    'npm uninstall -g openclaw >/dev/null 2>&1 || true',
    'if command -v pnpm >/dev/null 2>&1; then',
    '  pnpm remove -g openclaw >/dev/null 2>&1 || pnpm uninstall -g openclaw >/dev/null 2>&1 || true',
    '  pnpm_bin="$(pnpm bin -g 2>/dev/null || true)"',
    '  pnpm_root="$(pnpm root -g 2>/dev/null || true)"',
    '  if [ -n "$pnpm_bin" ]; then rm -f "$pnpm_bin/openclaw" "$pnpm_bin/openclaw.cmd" "$pnpm_bin/openclaw.ps1"; fi',
    '  if [ -n "$pnpm_root" ]; then rm -rf "$pnpm_root/openclaw"; fi',
    'fi',
    'npm_prefix="$(npm prefix -g 2>/dev/null || true)"',
    'npm_root="$(npm root -g 2>/dev/null || true)"',
    'if [ -n "$npm_prefix" ]; then rm -f "$npm_prefix/bin/openclaw" "$npm_prefix/bin/openclaw.cmd" "$npm_prefix/bin/openclaw.ps1"; fi',
    'if [ -n "$npm_root" ]; then rm -rf "$npm_root/openclaw"; fi',
    'hash -r >/dev/null 2>&1 || true'
  ].join('; ')

  await runInWsl(script, 120000)
}

const isOpenClawStillInstalledOnHost = async (): Promise<boolean> => {
  const baseEnv = getPathEnv()
  const managedEnv = getManagedNpmEnv(baseEnv)

  for (const env of [managedEnv, baseEnv]) {
    const openclaw = resolvePreferredBin('openclaw')
    if (await tryRunCommand(openclaw, ['--version'], env, 10000)) return true
  }

  return false
}

const isOpenClawStillInstalledInWsl = async (): Promise<boolean> => {
  try {
    await runInWsl('openclaw --version', 10000)
    return true
  } catch {
    return false
  }
}

const unsetNodeOptionsOnHost = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    spawn('launchctl', ['unsetenv', 'NODE_OPTIONS'])
      .on('close', () => resolve())
      .on('error', () => resolve())
  })
}

const removeConfigDirectory = async (isWin: boolean): Promise<void> => {
  if (isWin) {
    await runInWsl('rm -rf /root/.openclaw', 15000)
    return
  }

  // Clean up NODE_OPTIONS before deleting ipv4-fix.js (otherwise all Node processes get MODULE_NOT_FOUND)
  await unsetNodeOptionsOnHost()
  await rm(join(homedir(), '.openclaw'), { recursive: true, force: true })
}

const performOpenClawUninstall = async (
  opts: { removeConfig: boolean; unregisterWsl?: boolean },
  log: ProgressCallback
): Promise<void> => {
  const isWin = platform() === 'win32'

  log(t('uninstaller.stoppingGw'))
  try {
    await stopGateway()
  } catch {
    /* already stopped */
  }

  if (isWin && opts.unregisterWsl) {
    log(t('uninstaller.unregisteringWsl'))
    const result = await unregisterWslDistro()
    log(
      result === 'removed'
        ? t('uninstaller.unregisterWslDone')
        : t('uninstaller.unregisterWslMissing')
    )
    log(t('uninstaller.done'))
    return
  }

  log(t('uninstaller.removing'))
  if (isWin) {
    await removeOpenClawWslPackage()
    if (await isOpenClawStillInstalledInWsl()) {
      throw new Error(t('uninstaller.stillPresent'))
    }
  } else {
    await removeOpenClawHostPackage()
    if (await isOpenClawStillInstalledOnHost()) {
      throw new Error(t('uninstaller.stillPresent'))
    }
  }

  if (opts.removeConfig) {
    log(t('uninstaller.removingConfig'))
    await removeConfigDirectory(isWin)
  }

  log(t('uninstaller.done'))
}

export const cleanUninstallOpenClaw = async (): Promise<void> => {
  await performOpenClawUninstall({ removeConfig: true }, () => {})
}

export const uninstallOpenClaw = async (
  win: BrowserWindow,
  opts: { removeConfig: boolean; unregisterWsl?: boolean }
): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)
  await performOpenClawUninstall(opts, log)
}
