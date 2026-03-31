import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
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

const getWin = (): BrowserWindow | null => mainWindow

function createWindow(): void {
  const startHidden =
    app.getLoginItemSettings().wasOpenedAsHidden || process.argv.includes('--hidden')

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
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
    registerIpcHandlers(getWin)
    ipcRegistered = true
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const debugParams = new URLSearchParams()
    if (process.env.EASYCLAW_DEBUG_MINIMAL === '1') debugParams.set('debugMinimal', '1')
    if (process.env.EASYCLAW_DEBUG_MODE) debugParams.set('debugMode', process.env.EASYCLAW_DEBUG_MODE)
    const finalUrl = debugParams.size > 0 ? `${rendererUrl}?${debugParams.toString()}` : rendererUrl
    mainWindow.loadURL(finalUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Auto-start Gateway when launched hidden
  if (startHidden) {
    startGateway().catch(() => {})
  }
}

app.on('before-quit', () => {
  isQuitting = true
})

app.whenReady().then(async () => {
  applySavedInstallSourceSettings()
  await initI18nMain()
  electronApp.setAppUserModelId('com.modelfamily.openclaw.installer')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // System tray
  createTray({
    getWin,
    onQuit: async () => {
      isQuitting = true
      app.quit()
    }
  })
  startPolling()

  // Auto update
  setupAutoUpdater(getWin)
  setTimeout(checkForUpdates, 5000)

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
