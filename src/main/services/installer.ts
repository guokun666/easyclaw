import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { createWriteStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import https from 'https'
import { BrowserWindow } from 'electron'
import { checkWslState, runInWsl, WSL_STATE_ORDER, type WslState } from './wsl-utils'
import { getPathEnv } from './path-utils'
import { getManagedNpmEnv } from './npm-paths'
import { t } from '../../shared/i18n/main'
import {
  getNodeMacDownloadCandidates,
  getNodeWslSetupCandidates,
  getNpmCommandEnv,
  getOpenclawPackageCandidates
} from './install-sources'

type ProgressCallback = (msg: string) => void

interface RunError extends Error {
  lines?: string[]
}

interface InstallStatusPayload {
  percent: number
  stage: string
  detail?: string
}

const sendProgress = (win: BrowserWindow, msg: string): void => {
  win.webContents.send('install:progress', msg)
}

const sendStatus = (win: BrowserWindow, percent: number, stage: string, detail?: string): void => {
  const payload: InstallStatusPayload = {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    stage,
    detail
  }
  win.webContents.send('install:status', payload)
}

const downloadFile = (
  url: string,
  dest: string,
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  maxRedirects = 5
): Promise<void> =>
  new Promise((resolve, reject) => {
    let redirectCount = 0
    const follow = (u: string): void => {
      https
        .get(u, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume()
            if (++redirectCount > maxRedirects) {
              reject(new Error('Too many redirects'))
              return
            }
            follow(res.headers.location)
            return
          }
          if (!res.statusCode || res.statusCode >= 400) {
            res.resume()
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          const totalBytes = Number(res.headers['content-length'] ?? 0) || null
          let downloadedBytes = 0
          res.on('data', (chunk) => {
            downloadedBytes += chunk.length
            onProgress?.(downloadedBytes, totalBytes)
          })
          const file = createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => {
            file.close()
            resolve()
          })
          file.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url)
  })

const tryDownloadWithFallback = async (
  candidates: { label: string; url: string }[],
  dest: string,
  log: ProgressCallback,
  onCandidate?: (candidate: { label: string; url: string }) => void,
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void
): Promise<void> => {
  let lastError: Error | null = null

  for (const candidate of candidates) {
    try {
      onCandidate?.(candidate)
      log(`Download source: ${candidate.label}`)
      await downloadFile(candidate.url, dest, onProgress)
      log(`Download source selected: ${candidate.label}`)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      log(`Download source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All download sources failed')
}

const runWithLog = (
  cmd: string,
  args: string[],
  onLog: ProgressCallback,
  options?: { shell?: boolean; env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: options?.shell ?? false,
      env: options?.env ?? process.env,
      cwd: options?.cwd
    })

    const lines: string[] = []
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    child.stdout.on('data', (d) => {
      outDecoder
        .write(d)
        .split('\n')
        .filter(Boolean)
        .forEach((l) => {
          onLog(l)
          lines.push(l)
        })
    })
    child.stderr.on('data', (d) => {
      errDecoder
        .write(d)
        .split('\n')
        .filter(Boolean)
        .forEach((l) => {
          onLog(l)
          lines.push(l)
        })
    })
    child.on('close', (code) => {
      if (code === 0) resolve(lines)
      else {
        const err: RunError = new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${code})`)
        err.lines = lines
        reject(err)
      }
    })
    child.on('error', reject)
  })

const runStepsWithFallback = async (
  candidates: { label: string; run: () => Promise<unknown> }[],
  log: ProgressCallback
): Promise<void> => {
  let lastError: Error | null = null

  for (const candidate of candidates) {
    try {
      log(`Source candidate: ${candidate.label}`)
      await candidate.run()
      log(`Source selected: ${candidate.label}`)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      log(`Source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All source candidates failed')
}

// ─── WSL installation functions (Windows) ───

/** Install WSL itself (wsl --install -d Ubuntu --no-launch) — UAC elevation */
export const installWsl = async (
  win: BrowserWindow,
  prevState?: WslState
): Promise<{ needsReboot: boolean; state: WslState }> => {
  const log = (msg: string): void => sendProgress(win, msg)
  const baseline = prevState ?? (await checkWslState())

  sendStatus(win, 5, t('installer.wslInstalling'))
  log(t('installer.wslInstalling'))
  log(t('installer.wslAdminPrompt'))

  try {
    const psCommand = [
      'try {',
      "  $p = Start-Process -FilePath 'wsl' -ArgumentList '--install -d Ubuntu --no-launch' -Verb RunAs -Wait -PassThru;",
      '  exit $p.ExitCode',
      '} catch {',
      '  Write-Output $_.Exception.Message;',
      '  exit 1',
      '}'
    ].join(' ')
    await runWithLog('powershell', ['-NoProfile', '-Command', psCommand], log)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : ''
    const errLines = ((err as RunError).lines ?? []).join('\n')
    const lower = (errMsg + '\n' + errLines).toLowerCase()

    // Definite failures — throw immediately
    if (
      lower.includes('canceled') ||
      lower.includes('cancelled') ||
      lower.includes('elevation') ||
      lower.includes('access denied') ||
      lower.includes('permission')
    ) {
      throw new Error(t('installer.adminRequired'))
    }
    if (lower.includes('not recognized') || lower.includes('not found')) {
      throw new Error(t('installer.windowsVersionError'))
    }
    if (lower.includes('virtualization') || lower.includes('hyper-v')) {
      throw new Error(t('installer.biosVirtualization'))
    }
    // exit -1 (4294967295) is WSL's signal that a reboot is required
    if (errMsg.includes('exit -1') || errMsg.includes('exit 4294967295')) {
      log(t('installer.wslDone'))
      return { needsReboot: true, state: 'needs_reboot' }
    }
    // Other ambiguous errors — fall through to state check
  }

  // Verify actual WSL state regardless of exit code
  sendStatus(win, 80, t('installer.wslCheckingState'))
  log(t('installer.wslCheckingState'))
  const newState = await checkWslState()

  if (newState === 'ready') {
    sendStatus(win, 100, t('installer.wslDone'))
    log(t('installer.wslDone'))
    return { needsReboot: false, state: newState }
  }

  const improved = WSL_STATE_ORDER.indexOf(newState) > WSL_STATE_ORDER.indexOf(baseline)

  if (newState === 'needs_reboot' || improved) {
    sendStatus(win, 100, t('installer.wslDone'))
    log(t('installer.wslDone'))
    return { needsReboot: newState === 'needs_reboot', state: newState }
  }

  // No state change — actual failure; show user-friendly message
  throw new Error(t('installer.wslInstallFailed'))
}

/** Install Node.js 22 LTS inside WSL Ubuntu (NodeSource apt repo) */
export const installNodeWsl = async (win: BrowserWindow): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)

  sendStatus(win, 10, t('installer.wslPackages'))
  log(t('installer.wslPackages'))
  try {
    await runInWsl('apt-get update && apt-get install -y curl ca-certificates gnupg', 60000)
  } catch {
    log(t('installer.aptFailed'))
  }

  sendStatus(win, 45, t('installer.nodeWslInstalling'))
  log(t('installer.nodeWslInstalling'))
  const candidates = getNodeWslSetupCandidates()
  let lastError: Error | null = null

  for (const candidate of candidates) {
    try {
      sendStatus(win, 55, t('installer.nodeWslInstalling'), candidate.label)
      log(`Source candidate: ${candidate.label}`)
      await runInWsl(
        `curl -fsSL ${candidate.scriptUrl} | bash - && apt-get install -y nodejs`,
        120000
      )
      log(`Source selected: ${candidate.label}`)
      sendStatus(win, 100, t('installer.nodeWslDone'))
      log(t('installer.nodeWslDone'))
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      log(`Source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All source candidates failed')
}

/** Install openclaw globally inside WSL Ubuntu */
export const installOpenClawWsl = async (win: BrowserWindow): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)
  sendStatus(win, 10, t('installer.ocWslInstalling'))
  log(t('installer.ocWslInstalling'))

  await runStepsWithFallback(
    getOpenclawPackageCandidates().map((candidate) => ({
      label: candidate.label,
      run: () => {
        sendStatus(win, 55, t('installer.ocWslInstalling'), candidate.label)
        return runInWsl(
          `npm_config_registry=${candidate.registry} npm install -g ${candidate.packageName}`,
          120000
        )
      }
    })),
    log
  )

  sendStatus(win, 100, t('installer.ocWslDone'))
  log(t('installer.ocWslDone'))
}

// ─── macOS installation functions ───

export const installNodeMac = async (win: BrowserWindow): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)
  const nodeVersion = 'v22.16.0'
  const dest = join(tmpdir(), 'node-installer.pkg')

  sendStatus(win, 5, t('installer.nodeDownloading'))
  log(t('installer.nodeDownloading'))
  await tryDownloadWithFallback(
    getNodeMacDownloadCandidates(nodeVersion),
    dest,
    log,
    (candidate) => {
      sendStatus(win, 10, t('installer.nodeDownloading'), candidate.label)
    },
    (downloadedBytes, totalBytes) => {
      if (!totalBytes) return
      const percent = 10 + (downloadedBytes / totalBytes) * 70
      sendStatus(win, percent, t('installer.nodeDownloading'))
    }
  )

  // Try silent command-line install via osascript (admin privileges prompt)
  sendStatus(win, 85, t('installer.nodeInstalling'))
  log(t('installer.nodeInstalling'))
  try {
    const escapedDest = dest.replace(/'/g, "'\\''")
    await runWithLog(
      'osascript',
      [
        '-e',
        `do shell script "installer -pkg '${escapedDest}' -target /" with administrator privileges`
      ],
      log
    )
  } catch (silentErr) {
    // Fallback to GUI pkg installer if silent install fails
    log(`Silent install failed (${silentErr instanceof Error ? silentErr.message : silentErr}), falling back to GUI installer`)
    sendStatus(win, 88, t('installer.nodeInstallerOpening'))
    log(t('installer.nodeInstallerOpening'))
    await runWithLog('open', ['-W', dest], log)
  }

  sendStatus(win, 100, t('installer.nodeDone'))
  log(t('installer.nodeDone'))
}

// getPathEnv imported from path-utils.ts (includes NODE_OPTIONS removal)

const isXcodeCliInstalled = (): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn('xcode-select', ['-p'])
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })

const ensureXcodeCli = async (log: ProgressCallback): Promise<void> => {
  if (await isXcodeCliInstalled()) return

  log(t('installer.xcodeOpening'))
  spawn('xcode-select', ['--install'])

  log(t('installer.xcodePrompt'))
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    if (await isXcodeCliInstalled()) {
      log(t('installer.xcodeDone'))
      return
    }
  }
  throw new Error(t('installer.xcodeTimeout'))
}

export const installOpenClaw = async (win: BrowserWindow): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)
  sendStatus(win, 5, t('installer.ocInstalling'))
  log(t('installer.ocInstalling'))

  await ensureXcodeCli(log)
  sendStatus(win, 20, t('installer.ocInstalling'))
  const npmEnv = getManagedNpmEnv(getPathEnv())

  await runStepsWithFallback(
    getOpenclawPackageCandidates().map((candidate) => ({
      label: candidate.label,
      run: () => {
        sendStatus(win, 55, t('installer.ocInstalling'), candidate.label)
        return runWithLog('npm', ['install', '-g', candidate.packageName], log, {
          env: getNpmCommandEnv(candidate.registry, npmEnv)
        })
      }
    })),
    log
  )

  sendStatus(win, 100, t('installer.ocDone'))
  log(t('installer.ocDone'))
}
