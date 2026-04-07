import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { createWriteStream, readFileSync, appendFileSync, existsSync, type WriteStream } from 'fs'
import { tmpdir, homedir, platform } from 'os'
import { join } from 'path'
import https from 'https'
import type { ClientRequest } from 'http'
import { BrowserWindow } from 'electron'
import {
  buildWslBashArgs,
  checkWslState,
  getWslProxyRuntimeInfo,
  WSL_STATE_ORDER,
  type WslState
} from './wsl-utils'
import { getPathEnv } from './path-utils'
import { getManagedNpmEnv, getManagedBinPath, hasManagedBin } from './npm-paths'
import { t } from '../../shared/i18n/main'
import {
  getNodeMacDownloadCandidates,
  getNodeWslSetupCandidates,
  getInstallSourceSettingsFromEnv,
  getNpmCommandEnv,
  normalizeOpenclawVersion,
  getOpenclawPackageCandidates
} from './install-sources'
import { ensureRetainedPluginCompatibility } from './onboarder'

type ProgressCallback = (msg: string) => void

interface RunError extends Error {
  lines?: string[]
}

interface InstallStatusPayload {
  percent: number
  stage: string
  detail?: string
}

interface ActiveInstallTask {
  cancelled: boolean
  children: Set<ChildProcess>
  requests: Set<ClientRequest>
  streams: Set<WriteStream>
}

type InstallPhase = 'node' | 'openclaw'

const INSTALL_CANCELLED_MESSAGE = 'INSTALL_CANCELLED'
let activeInstallTask: ActiveInstallTask | null = null

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

const createInstallCancelledError = (): Error => new Error(INSTALL_CANCELLED_MESSAGE)

const isInstallCancelledError = (error: unknown): boolean =>
  error instanceof Error && error.message === INSTALL_CANCELLED_MESSAGE

const getActiveInstallTask = (): ActiveInstallTask | null => activeInstallTask

export const beginInstallTask = (): void => {
  activeInstallTask = {
    cancelled: false,
    children: new Set<ChildProcess>(),
    requests: new Set<ClientRequest>(),
    streams: new Set<WriteStream>()
  }
}

export const endInstallTask = (): void => {
  activeInstallTask = null
}

export const cancelActiveInstall = (): boolean => {
  const task = activeInstallTask
  if (!task) return false

  task.cancelled = true
  for (const child of task.children) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  for (const request of task.requests) {
    try {
      request.destroy(createInstallCancelledError())
    } catch {
      /* ignore */
    }
  }
  for (const stream of task.streams) {
    try {
      stream.destroy(createInstallCancelledError())
    } catch {
      /* ignore */
    }
  }

  return true
}

const assertInstallNotCancelled = (): void => {
  if (getActiveInstallTask()?.cancelled) {
    throw createInstallCancelledError()
  }
}

const registerInstallChild = (child: ChildProcess): void => {
  const task = getActiveInstallTask()
  if (!task) return

  task.children.add(child)
  const cleanup = (): void => {
    task.children.delete(child)
  }
  child.once('close', cleanup)
  child.once('error', cleanup)

  if (task.cancelled) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
}

const registerInstallRequest = (request: ClientRequest): void => {
  const task = getActiveInstallTask()
  if (!task) return

  task.requests.add(request)
  const cleanup = (): void => {
    task.requests.delete(request)
  }
  request.once('close', cleanup)
  request.once('error', cleanup)

  if (task.cancelled) {
    request.destroy(createInstallCancelledError())
  }
}

const registerInstallStream = (stream: WriteStream): void => {
  const task = getActiveInstallTask()
  if (!task) return

  task.streams.add(stream)
  const cleanup = (): void => {
    task.streams.delete(stream)
  }
  stream.once('close', cleanup)
  stream.once('error', cleanup)

  if (task.cancelled) {
    stream.destroy(createInstallCancelledError())
  }
}

const extractErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isLikelyNetworkInstallError = (message: string): boolean =>
  /etimedout|timed out|socket hang up|econnreset|econnrefused|eai_again|enotfound|network is unreachable|temporary failure|name resolution|certificate|self signed|unable to get local issuer|proxy|407|403|502|503|tunneling socket|fetch failed|download source failed|source failed|http\s+\d{3}/i.test(
    message
  )

const getAlternativeSourceLabels = (current: ReturnType<typeof getInstallSourceSettingsFromEnv>['sourceMode']): string => {
  const options = ['npmmirror', '腾讯云镜像', '官方源']
  if (current === 'npmmirror') return '腾讯云镜像或官方源'
  if (current === 'tencent') return 'npmmirror 或官方源'
  if (current === 'official') return 'npmmirror 或腾讯云镜像'
  return options.join(' / ')
}

const buildInstallFailureDiagnosis = async (
  phase: InstallPhase,
  rawMessage: string
): Promise<string | null> => {
  if (!isLikelyNetworkInstallError(rawMessage)) return null

  const normalized = rawMessage.toLowerCase()
  const sourceMode = getInstallSourceSettingsFromEnv().sourceMode
  const proxyInfo = platform() === 'win32' ? await getWslProxyRuntimeInfo() : null

  let cause = t('installer.networkCauseRegistry')
  if (/certificate|self signed|unable to get local issuer|ssl|tls|cert_/i.test(normalized)) {
    cause = t('installer.networkCauseTls')
  } else if (/proxy|407|tunneling socket|connect econnrefused 127\.0\.0\.1|connect econnrefused localhost/i.test(normalized)) {
    cause = t('installer.networkCauseProxy')
  } else if (/enotfound|eai_again|name resolution|temporary failure|dns/i.test(normalized)) {
    cause = t('installer.networkCauseDns')
  } else if (/etimedout|timed out|socket hang up|econnreset|network is unreachable/i.test(normalized)) {
    cause = t('installer.networkCauseTimeout')
  }

  const hints = [
    t('installer.networkFixSwitchSource', {
      alternatives: getAlternativeSourceLabels(sourceMode)
    }),
    t('installer.networkFixRetry')
  ]

  if (proxyInfo?.enabled) {
    hints.splice(
      1,
      0,
      t('installer.networkFixProxy', {
        proxy: proxyInfo.displayValue ?? 'localhost'
      })
    )
  }

  if (/enotfound|eai_again|name resolution|temporary failure|network is unreachable|timed out/i.test(normalized)) {
    hints.splice(1, 0, t('installer.networkFixDns'))
  }

  if (/certificate|self signed|unable to get local issuer|ssl|tls|cert_/i.test(normalized)) {
    hints.splice(1, 0, t('installer.networkFixTls'))
  }

  if (phase === 'node' && platform() === 'win32') {
    hints.splice(1, 0, t('installer.networkFixNodeWsl'))
  }

  return [
    t('installer.networkDiagnoseTitle'),
    `- ${cause}`,
    ...hints.map((hint) => `- ${hint}`)
  ].join('\n')
}

export const buildInstallFailureMessage = async (
  phase: InstallPhase,
  error: unknown
): Promise<string> => {
  const rawMessage = extractErrorMessage(error)
  if (rawMessage === INSTALL_CANCELLED_MESSAGE) return rawMessage

  const diagnosis = await buildInstallFailureDiagnosis(phase, rawMessage)
  return diagnosis ? `${rawMessage}\n\n${diagnosis}` : rawMessage
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
      assertInstallNotCancelled()
      const request = https.get(u, (res) => {
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
            if (getActiveInstallTask()?.cancelled) {
              request.destroy(createInstallCancelledError())
              return
            }
            downloadedBytes += chunk.length
            onProgress?.(downloadedBytes, totalBytes)
          })
          const file = createWriteStream(dest)
          registerInstallStream(file)
          res.pipe(file)
          file.on('finish', () => {
            file.close()
            if (getActiveInstallTask()?.cancelled) {
              reject(createInstallCancelledError())
              return
            }
            resolve()
          })
          file.on('error', reject)
        })
      registerInstallRequest(request)
      request.on('error', reject)
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
    assertInstallNotCancelled()
    try {
      onCandidate?.(candidate)
      log(`Download source: ${candidate.label}`)
      await downloadFile(candidate.url, dest, onProgress)
      log(`Download source selected: ${candidate.label}`)
      return
    } catch (error) {
      if (isInstallCancelledError(error)) {
        throw error
      }
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
    assertInstallNotCancelled()
    const child = spawn(cmd, args, {
      shell: options?.shell ?? false,
      env: options?.env ?? process.env,
      cwd: options?.cwd
    })
    registerInstallChild(child)

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
      if (getActiveInstallTask()?.cancelled) {
        reject(createInstallCancelledError())
        return
      }
      if (code === 0) resolve(lines)
      else {
        const err: RunError = new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${code})`)
        err.lines = lines
        reject(err)
      }
    })
    child.on('error', (error) => {
      if (getActiveInstallTask()?.cancelled) {
        reject(createInstallCancelledError())
        return
      }
      reject(error)
    })
  })

const runStepsWithFallback = async (
  candidates: { label: string; run: () => Promise<unknown> }[],
  log: ProgressCallback
): Promise<void> => {
  let lastError: Error | null = null

  for (const candidate of candidates) {
    assertInstallNotCancelled()
    try {
      log(`Source candidate: ${candidate.label}`)
      await candidate.run()
      log(`Source selected: ${candidate.label}`)
      return
    } catch (error) {
      if (isInstallCancelledError(error)) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
      log(`Source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All source candidates failed')
}

const runInWslForInstall = async (script: string, timeout = 30000): Promise<string> => {
  const args = await buildWslBashArgs(script)
  assertInstallNotCancelled()

  return new Promise((resolve, reject) => {
    const child = spawn('wsl', args)
    registerInstallChild(child)

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error('timeout'))
    }, timeout)

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (getActiveInstallTask()?.cancelled) {
        reject(createInstallCancelledError())
        return
      }
      if (code === 0) {
        resolve(stdout.replace(/\0/g, '').trim())
        return
      }
      reject(new Error(stderr.replace(/\0/g, '').trim() || `exit ${code}`))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (getActiveInstallTask()?.cancelled) {
        reject(createInstallCancelledError())
        return
      }
      reject(error)
    })
  })
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
    await runInWslForInstall('apt-get update && apt-get install -y curl ca-certificates gnupg', 60000)
  } catch (error) {
    if (isInstallCancelledError(error)) {
      throw error
    }
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
      await runInWslForInstall(
        `curl -fsSL ${candidate.scriptUrl} | bash - && apt-get install -y nodejs`,
        120000
      )
      log(`Source selected: ${candidate.label}`)
      sendStatus(win, 100, t('installer.nodeWslDone'))
      log(t('installer.nodeWslDone'))
      return
    } catch (error) {
      if (isInstallCancelledError(error)) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
      log(`Source failed: ${candidate.label} (${lastError.message})`)
    }
  }

  throw lastError ?? new Error('All source candidates failed')
}

/** Install openclaw globally inside WSL Ubuntu */
export const installOpenClawWsl = async (
  win: BrowserWindow,
  version?: string
): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)
  const targetVersion = normalizeOpenclawVersion(version)
  sendStatus(win, 10, t('installer.ocWslInstalling'))
  log(t('installer.ocWslInstalling', { version: targetVersion }))

  await runStepsWithFallback(
    getOpenclawPackageCandidates(targetVersion).map((candidate) => ({
      label: candidate.label,
      run: () => {
        sendStatus(win, 55, t('installer.ocWslInstalling', { version: targetVersion }), candidate.label)
        return runInWslForInstall(
          `npm_config_registry=${candidate.registry} npm install -g ${candidate.packageName}`,
          120000
        )
      }
    })),
    log
  )

  await ensureRetainedPluginCompatibility(targetVersion, log)
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

  // Ensure /usr/local/bin is in user's shell PATH so node/openclaw are globally accessible
  ensureUsrLocalBinInPath(log)

  sendStatus(win, 100, t('installer.nodeDone'))
  log(t('installer.nodeDone'))
}

/** Append /usr/local/bin to the user's shell profile if not already present */
const ensureUsrLocalBinInPath = (log: ProgressCallback): void => {
  const home = homedir()
  const profileCandidates = ['.zshrc', '.bash_profile', '.bashrc', '.profile']
  const target = '/usr/local/bin'

  for (const name of profileCandidates) {
    const filePath = join(home, name)
    if (!existsSync(filePath)) continue

    try {
      const content = readFileSync(filePath, 'utf-8')
      // Check if /usr/local/bin is already referenced in PATH exports
      if (content.includes(target)) {
        log(`${name} already contains ${target}`)
        return
      }
    } catch {
      continue
    }
  }

  // Append to .zshrc (default macOS shell) or .bash_profile
  const shellProfile = join(home, existsSync(join(home, '.zshrc')) ? '.zshrc' : '.bash_profile')
  try {
    appendFileSync(
      shellProfile,
      `\n# Added by familyClaw installer\nexport PATH="/usr/local/bin:$PATH"\n`,
      'utf-8'
    )
    log(`Added ${target} to ${shellProfile}`)
  } catch (err) {
    log(`Failed to update shell profile: ${err instanceof Error ? err.message : err}`)
  }
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

export const installOpenClaw = async (
  win: BrowserWindow,
  version?: string
): Promise<void> => {
  const log = (msg: string): void => sendProgress(win, msg)
  const targetVersion = normalizeOpenclawVersion(version)
  sendStatus(win, 5, t('installer.ocInstalling'))
  log(t('installer.ocInstalling', { version: targetVersion }))

  await ensureXcodeCli(log)
  sendStatus(win, 20, t('installer.ocInstalling'))
  const npmEnv = getManagedNpmEnv(getPathEnv())

  await runStepsWithFallback(
    getOpenclawPackageCandidates(targetVersion).map((candidate) => ({
      label: candidate.label,
      run: () => {
        sendStatus(win, 55, t('installer.ocInstalling', { version: targetVersion }), candidate.label)
        return runWithLog('npm', ['install', '-g', candidate.packageName], log, {
          env: getNpmCommandEnv(candidate.registry, npmEnv)
        })
      }
    })),
    log
  )

  // Symlink openclaw to /usr/local/bin so it's available globally in terminal
  if (process.platform === 'darwin' && hasManagedBin('openclaw')) {
    try {
      const src = getManagedBinPath('openclaw')
      const dest = '/usr/local/bin/openclaw'
      await runWithLog(
        'osascript',
        [
          '-e',
          `do shell script "mkdir -p /usr/local/bin && ln -sf '${src.replace(/'/g, "'\\''")}' '${dest}'" with administrator privileges`
        ],
        log
      )
      log('Symlinked openclaw to /usr/local/bin')
    } catch (linkErr) {
      log(`Symlink to /usr/local/bin skipped (${linkErr instanceof Error ? linkErr.message : linkErr})`)
    }
  }

  await ensureRetainedPluginCompatibility(targetVersion, log)
  sendStatus(win, 100, t('installer.ocDone'))
  log(t('installer.ocDone'))
}
