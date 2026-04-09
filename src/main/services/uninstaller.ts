import { spawn } from 'child_process'
import { rm } from 'fs/promises'
import { homedir, platform } from 'os'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { stopGateway } from './gateway'
import { getPathEnv, resolvePreferredBin } from './path-utils'
import { getManagedNpmEnv } from './npm-paths'
import { getPackageManagerBin, getPackageManagerGlobalRemoveArgs } from './package-manager'
import { runInWsl, unregisterWslDistro } from './wsl-utils'
import { t } from '../../shared/i18n/main'

const sendProgress = (win: BrowserWindow, msg: string): void => {
  try {
    win.webContents.send('uninstall:progress', msg)
  } catch {
    /* window destroyed */
  }
}

const runHostUninstall = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: getManagedNpmEnv(getPathEnv())
    })
    child.stdout.resume()
    child.stderr.resume()
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} uninstall failed (exit ${code})`))
    })
    child.on('error', reject)
  })

const uninstallMac = async (): Promise<void> => {
  try {
    await runHostUninstall(getPackageManagerBin(), getPackageManagerGlobalRemoveArgs('openclaw'))
  } catch {
    const npm = resolvePreferredBin('npm')
    await runHostUninstall(npm, ['uninstall', '-g', 'openclaw'])
  }
}

export const uninstallOpenClaw = async (
  win: BrowserWindow,
  opts: { removeConfig: boolean; unregisterWsl?: boolean }
): Promise<void> => {
  const isWin = platform() === 'win32'
  const log = (msg: string): void => sendProgress(win, msg)

  // 1. Stop gateway
  log(t('uninstaller.stoppingGw'))
  try {
    await stopGateway()
  } catch {
    /* already stopped */
  }

  if (isWin && opts.unregisterWsl) {
    log(t('uninstaller.unregisteringWsl'))
    const result = await unregisterWslDistro()
    log(result === 'removed' ? t('uninstaller.unregisterWslDone') : t('uninstaller.unregisterWslMissing'))
    log(t('uninstaller.done'))
    return
  }

  // 2. Remove the global OpenClaw package
  log(t('uninstaller.removing'))
  if (isWin) {
    await runInWsl('pnpm remove -g openclaw || npm uninstall -g openclaw', 60000)
  } else {
    await uninstallMac()
  }

  // 3. (Optional) Remove config directory
  if (opts.removeConfig) {
    log(t('uninstaller.removingConfig'))
    if (isWin) {
      await runInWsl('rm -rf /root/.openclaw', 15000)
    } else {
      // Clean up NODE_OPTIONS before deleting ipv4-fix.js (otherwise all Node processes get MODULE_NOT_FOUND)
      await new Promise<void>((r) => {
        spawn('launchctl', ['unsetenv', 'NODE_OPTIONS'])
          .on('close', () => r())
          .on('error', () => r())
      })
      await rm(join(homedir(), '.openclaw'), { recursive: true, force: true })
    }
  }

  log(t('uninstaller.done'))
}
