import { spawn, ChildProcess } from 'child_process'
import { platform } from 'os'
import { getPathEnv, resolvePreferredBin } from './path-utils'
import { checkPort } from './troubleshooter'
import { t } from '../../shared/i18n/main'

export interface GatewayResult {
  status: string
  error?: string
}

// Windows WSL: keep gateway as a foreground process
let wslGatewayProcess: ChildProcess | null = null

// Gateway log callback (set from ipc-handlers)
let logCallback: ((msg: string) => void) | null = null

export const setGatewayLogCallback = (cb: ((msg: string) => void) | null): void => {
  logCallback = cb
}

const emitLog = (msg: string): void => {
  logCallback?.(msg)
}

const runGateway = (args: string[]): Promise<string> => {
  const openclaw = resolvePreferredBin('openclaw')
  const fullArgs = ['gateway', ...args]

  return new Promise((resolve, reject) => {
    const child = spawn(openclaw, fullArgs, {
      env: getPathEnv()
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr || `exit code ${code}`))
    })
    child.on('error', reject)
  })
}

const waitForGatewayPort = async (timeoutMs = 10000, intervalMs = 500): Promise<boolean> => {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (!wslGatewayProcess || wslGatewayProcess.killed) return false

    const { inUse } = await checkPort()
    if (inUse) return true

    await new Promise((r) => setTimeout(r, intervalMs))
  }

  return false
}

const startGatewayWsl = async (): Promise<GatewayResult> => {
  if (wslGatewayProcess) {
    wslGatewayProcess.kill()
    wslGatewayProcess = null
  }
  await killWslGateway()
  await new Promise((r) => setTimeout(r, 1000))

  return new Promise((resolve) => {
    const child = spawn(
      'wsl',
      [
        '-d',
        'Ubuntu',
        '-u',
        'root',
        '--',
        'bash',
        '-lc',
        'NODE_OPTIONS=--dns-result-order=ipv4first openclaw gateway run'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    wslGatewayProcess = child

    let resolved = false
    let stderrBuffer = ''
    const stdoutLines: string[] = []

    child.stdout.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) {
        emitLog(msg)
        stdoutLines.push(msg)
      }
    })

    child.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) {
        emitLog(msg)
        stderrBuffer += msg + '\n'
      }
    })

    child.on('close', (code) => {
      wslGatewayProcess = null
      emitLog(t('gateway.processExit', { code }))
      if (code !== 0 && stderrBuffer) {
        emitLog(`${t('gateway.errorDetail')}\n${stderrBuffer.trim()}`)
      }
      if (!resolved) {
        resolved = true
        if (code !== 0) {
          resolve({ status: 'stopped', error: stderrBuffer.trim() || `exit code ${code}` })
        } else {
          resolve({ status: 'stopped' })
        }
      }
    })

    child.on('error', (err) => {
      wslGatewayProcess = null
      emitLog(t('gateway.error', { message: err.message }))
      if (!resolved) {
        resolved = true
        resolve({ status: 'error', error: err.message })
      }
    })

    void (async () => {
      const portReady = await waitForGatewayPort()
      if (resolved) return

      if (portReady) {
        resolved = true
        resolve({ status: 'started' })
        return
      }

      if (wslGatewayProcess && !wslGatewayProcess.killed) {
        const error =
          stderrBuffer.trim() ||
          stdoutLines[stdoutLines.length - 1] ||
          'Gateway did not become ready in time'
        wslGatewayProcess.kill()
        await killWslGateway().catch(() => {})
        wslGatewayProcess = null
        resolved = true
        resolve({ status: 'error', error })
      }
    })()
  })
}

const killWslGateway = (): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn('wsl', [
      '-d',
      'Ubuntu',
      '-u',
      'root',
      '--',
      'pkill',
      '-9',
      '-f',
      'openclaw'
    ])
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })

const stopGatewayWsl = async (): Promise<string> => {
  if (wslGatewayProcess) {
    wslGatewayProcess.kill()
    wslGatewayProcess = null
  }
  await killWslGateway()
  await new Promise((r) => setTimeout(r, 1000))
  return 'stopped'
}

const runDoctorFix = (): Promise<void> =>
  new Promise((resolve) => {
    const isWin = platform() === 'win32'
    let cmd: string
    let args: string[]

    if (isWin) {
      cmd = 'wsl'
      args = ['-d', 'Ubuntu', '-u', 'root', '--', 'bash', '-lc', 'openclaw doctor --fix']
    } else {
      cmd = resolvePreferredBin('openclaw')
      args = ['doctor', '--fix']
    }

    const child = spawn(cmd, args, {
      env: isWin ? process.env : getPathEnv()
    })
    child.stdout.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) emitLog(msg)
    })
    child.stderr.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) emitLog(msg)
    })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })

const forceKillGateway = (): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn('pkill', ['-f', 'openclaw gateway'])
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })

export const waitUntilStopped = async (timeoutMs = 5000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { inUse } = await checkPort()
    if (!inUse) return
    await new Promise((r) => setTimeout(r, 500))
  }
  if (platform() !== 'win32') {
    await forceKillGateway()
    await new Promise((r) => setTimeout(r, 1000))
  }
}

export const startGateway = async (): Promise<GatewayResult> => {
  const isWin = platform() === 'win32'
  if (isWin) {
    const result = await startGatewayWsl()
    if (result.status === 'started') {
      await runDoctorFix()
    }
    return result
  }

  try {
    await runGateway(['start'])
    await runDoctorFix()
    return { status: 'started' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isServiceMissing =
      msg.includes('not loaded') || msg.includes('not installed') || msg.includes('bootstrap')
    if (!isServiceMissing) return { status: 'error', error: msg }

    // Auto-install and retry when launchd service is not installed
    emitLog(t('gateway.notInstalledRetry'))
    try {
      await runGateway(['install'])
      await runGateway(['start'])
      await runDoctorFix()
      return { status: 'started' }
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
      return { status: 'error', error: retryMsg }
    }
  }
}

export const stopGateway = (): Promise<string> => {
  const isWin = platform() === 'win32'
  if (isWin) return stopGatewayWsl()
  return runGateway(['stop'])
}

export const restartGateway = async (): Promise<GatewayResult> => {
  try {
    await stopGateway()
  } catch {
    /* already stopped */
  }
  await waitUntilStopped()
  return startGateway()
}

export const getGatewayStatus = async (): Promise<'running' | 'stopped'> => {
  if (platform() === 'win32') {
    if (!wslGatewayProcess || wslGatewayProcess.killed) return 'stopped'
    const { inUse } = await checkPort()
    return inUse ? 'running' : 'stopped'
  }
  try {
    const output = await runGateway(['status'])
    return output.toLowerCase().includes('running') ? 'running' : 'stopped'
  } catch {
    return 'stopped'
  }
}
