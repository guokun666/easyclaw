import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers, applySavedInstallSourceSettings } from './ipc-handlers'
import { createTray, startPolling, destroyTray } from './services/tray-manager'
import { setupAutoUpdater, checkForUpdates } from './services/updater'
import { startGateway } from './services/gateway'
import { initI18nMain } from '../shared/i18n/main'
import icon from '../../resources/icon.png?asset'

let ipcRegistered = false
let mainWindow: BrowserWindow | null = null
let isQuitting = false

const writeStartupLog = (message: string): void => {
  try {
    const logDir = join(app.getPath('userData'))
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    appendFileSync(join(logDir, 'startup.log'), `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (error) => {
  writeStartupLog(`uncaughtException: ${error.stack ?? error.message}`)
})

process.on('unhandledRejection', (reason) => {
  const detail =
    reason instanceof Error ? reason.stack ?? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason)
  writeStartupLog(`unhandledRejection: ${detail}`)
})

const getWin = (): BrowserWindow | null => mainWindow
const WINDOW_MARGIN = 48
const MIN_WINDOW_WIDTH = 1040
const MIN_WINDOW_HEIGHT = 680
const MAX_WINDOW_WIDTH = 1480
const MAX_WINDOW_HEIGHT = 960
const BASELINE_WORKAREA_WIDTH = 1440
const BASELINE_WORKAREA_HEIGHT = 900

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max)
}

const getInitialWindowBounds = (): {
  width: number
  height: number
  minWidth: number
  minHeight: number
  zoomFactor: number
} => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { width: workAreaWidth, height: workAreaHeight } = display.workAreaSize
  const maxAllowedWidth = Math.max(MIN_WINDOW_WIDTH, workAreaWidth - WINDOW_MARGIN)
  const maxAllowedHeight = Math.max(MIN_WINDOW_HEIGHT, workAreaHeight - WINDOW_MARGIN)
  const minWidth = Math.min(MIN_WINDOW_WIDTH, maxAllowedWidth)
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, maxAllowedHeight)
  const width = clamp(
    Math.round(workAreaWidth * 0.78),
    minWidth,
    Math.min(MAX_WINDOW_WIDTH, maxAllowedWidth)
  )
  const height = clamp(
    Math.round(workAreaHeight * 0.86),
    minHeight,
    Math.min(MAX_WINDOW_HEIGHT, maxAllowedHeight)
  )
  const viewportScale = Math.min(
    workAreaWidth / BASELINE_WORKAREA_WIDTH,
    workAreaHeight / BASELINE_WORKAREA_HEIGHT
  )
  const zoomFactor =
    viewportScale >= 1.6 ? 1.18 : viewportScale >= 1.3 ? 1.12 : viewportScale >= 1.15 ? 1.08 : 1

  return { width, height, minWidth, minHeight, zoomFactor }
}

function createWindow(): void {
  writeStartupLog('createWindow:start')
  const startHidden =
    app.getLoginItemSettings().wasOpenedAsHidden || process.argv.includes('--hidden')
  const { width, height, minWidth, minHeight, zoomFactor } = getInitialWindowBounds()

  mainWindow = new BrowserWindow({
    width,
    height,
    resizable: true,
    minWidth,
    minHeight,
    show: false,
    center: true,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow.webContents.setZoomFactor(zoomFactor)

  mainWindow.on('ready-to-show', () => {
    writeStartupLog(`createWindow:ready-to-show hidden=${startHidden}`)
    if (!startHidden) mainWindow?.show()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('render-process-gone', details)
  })
  mainWindow.webContents.on('unresponsive', () => {
    console.error('renderer-unresponsive')
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('did-fail-load', { errorCode, errorDescription })
  })

  // Close window → stay in tray (not a real quit)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (['https:', 'tg:'].includes(url.protocol)) {
        shell.openExternal(details.url)
      }
    } catch {
      /* invalid URL — ignore */
    }
    return { action: 'deny' }
  })

  if (!ipcRegistered) {
    writeStartupLog('createWindow:register-ipc')
    registerIpcHandlers(getWin)
    ipcRegistered = true
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    writeStartupLog('createWindow:loadURL')
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const debugParams = new URLSearchParams()
    if (process.env.EASYCLAW_DEBUG_MINIMAL === '1') debugParams.set('debugMinimal', '1')
    if (process.env.EASYCLAW_DEBUG_MODE) debugParams.set('debugMode', process.env.EASYCLAW_DEBUG_MODE)
    const finalUrl = debugParams.size > 0 ? `${rendererUrl}?${debugParams.toString()}` : rendererUrl
    mainWindow.loadURL(finalUrl)
  } else {
    writeStartupLog('createWindow:loadFile')
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Auto-start Gateway when launched hidden
  if (startHidden) {
    startGateway().catch(() => {})
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
writeStartupLog(`singleInstanceLock=${gotSingleInstanceLock}`)

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.whenReady().then(async () => {
  writeStartupLog('app:ready')
  applySavedInstallSourceSettings()
  await initI18nMain()
  writeStartupLog('app:i18n-ready')
  electronApp.setAppUserModelId('com.modelfamily.familyclaw')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  writeStartupLog('app:window-created')

  createTray({
    getWin,
    onQuit: async () => {
      isQuitting = true
      app.quit()
    }
  })
  startPolling()
  writeStartupLog('app:tray-ready')

  // Auto update
  setupAutoUpdater(getWin)
  setTimeout(checkForUpdates, 5000)
  writeStartupLog('app:updater-ready')

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
})

// Stay in tray — keep app alive even when all windows are closed
app.on('window-all-closed', () => {
  // Do not quit in tray mode
})

app.on('quit', () => {
  destroyTray()
})
