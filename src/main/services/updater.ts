import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getAppUpdateFeedUrl } from './install-sources'

const configureUpdateFeed = (): void => {
  const feedUrl = getAppUpdateFeedUrl()
  if (!feedUrl) return

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl
  })
}

export const setupAutoUpdater = (getWin: () => BrowserWindow | null): void => {
  if (is.dev) return

  configureUpdateFeed()

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:available', { version: info.version })
    }
  })

  autoUpdater.on('download-progress', (p) => {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:progress', Math.round(p.percent))
    }
  })

  autoUpdater.on('update-downloaded', () => {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:downloaded')
    }
  })

  autoUpdater.on('error', (e) => {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:error', e.message)
    }
  })
}

export const checkForUpdates = (): void => {
  if (is.dev) return
  configureUpdateFeed()
  autoUpdater.checkForUpdates().catch(() => {
    // Ignore network errors
  })
}

export const downloadUpdate = (): void => {
  autoUpdater.downloadUpdate().catch(() => {})
}

export const installUpdate = (): void => {
  autoUpdater.quitAndInstall()
}
