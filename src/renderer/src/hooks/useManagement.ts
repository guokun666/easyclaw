import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModalPhase } from '../components/ManagementModal'

interface UninstallState {
  modal: ModalPhase | null
  removeConfig: boolean
  unregisterWsl: boolean
  progress: string
  error: string
}

interface BackupRestoreState {
  backupModal: ModalPhase | null
  backupMsg: string
  restoreModal: ModalPhase | null
  restoreMsg: string
}

interface ManagementActions {
  uninstall: UninstallState & {
    open: () => void
    close: () => void
    setRemoveConfig: (v: boolean) => void
    setUnregisterWsl: (v: boolean) => void
    execute: () => Promise<void>
  }
  backup: BackupRestoreState & {
    execute: () => Promise<void>
    closeBackup: () => void
    openRestore: () => void
    closeRestore: () => void
    executeRestore: () => Promise<void>
  }
}

export const useManagement = (
  onStatusChange: (status: 'starting' | 'running' | 'stopped') => void,
  isWindows: boolean
): ManagementActions => {
  const { t } = useTranslation('management')
  const [uninstall, setUninstall] = useState<UninstallState>({
    modal: null,
    removeConfig: false,
    unregisterWsl: false,
    progress: '',
    error: ''
  })

  const [br, setBr] = useState<BackupRestoreState>({
    backupModal: null,
    backupMsg: '',
    restoreModal: null,
    restoreMsg: ''
  })

  useEffect(() => {
    const unsub = window.electronAPI.uninstall.onProgress((msg) => {
      setUninstall((prev) => ({ ...prev, progress: msg }))
    })
    return unsub
  }, [])

  const executeUninstall = async (): Promise<void> => {
    setUninstall((prev) => ({ ...prev, modal: 'progress', progress: t('uninstall.preparing') }))
    const r = await window.electronAPI.uninstall.openclaw({
      removeConfig: uninstall.removeConfig || uninstall.unregisterWsl,
      unregisterWsl: uninstall.unregisterWsl
    })
    if (r.success) {
      setUninstall((prev) => ({ ...prev, modal: 'done', progress: t('uninstall.completed') }))
    } else {
      setUninstall((prev) => ({
        ...prev,
        modal: 'error',
        error: r.error || t('uninstall.errorFallback')
      }))
    }
  }

  const executeBackup = async (): Promise<void> => {
    setBr((prev) => ({
      ...prev,
      backupModal: 'progress',
      backupMsg: t('backupRestore.backupProgress')
    }))
    const r = await window.electronAPI.backup.export()
    if (r.success) {
      setBr((prev) => ({ ...prev, backupModal: 'done', backupMsg: t('backupRestore.backupDone') }))
    } else if (r.error === 'CANCELLED') {
      setBr((prev) => ({ ...prev, backupModal: null }))
    } else {
      setBr((prev) => ({
        ...prev,
        backupModal: 'error',
        backupMsg: r.error || t('backupRestore.backupError')
      }))
    }
  }

  const executeRestore = async (): Promise<void> => {
    setBr((prev) => ({
      ...prev,
      restoreModal: 'progress',
      restoreMsg: t('backupRestore.restoreProgress')
    }))
    const r = await window.electronAPI.backup.import()
    if (r.success) {
      setBr((prev) => ({
        ...prev,
        restoreModal: 'done',
        restoreMsg: t('backupRestore.restoreDone')
      }))
      onStatusChange('starting')
      await new Promise((r) => setTimeout(r, 2000))
      const gs = await window.electronAPI.gateway.status()
      onStatusChange(gs === 'running' ? 'running' : 'stopped')
    } else if (r.error === 'CANCELLED') {
      setBr((prev) => ({ ...prev, restoreModal: null }))
    } else {
      setBr((prev) => ({
        ...prev,
        restoreModal: 'error',
        restoreMsg: r.error || t('backupRestore.restoreError')
      }))
    }
  }

  return {
    uninstall: {
      ...uninstall,
      open: () =>
        setUninstall((prev) => ({
          ...prev,
          modal: 'confirm',
          removeConfig: false,
          unregisterWsl: false,
          progress: '',
          error: ''
        })),
      close: () => setUninstall((prev) => ({ ...prev, modal: null })),
      setRemoveConfig: (v) => setUninstall((prev) => ({ ...prev, removeConfig: v })),
      setUnregisterWsl: (v: boolean) =>
        setUninstall((prev) => ({
          ...prev,
          unregisterWsl: isWindows ? v : false,
          removeConfig: v ? true : prev.removeConfig
        })),
      execute: executeUninstall
    },
    backup: {
      ...br,
      execute: executeBackup,
      closeBackup: () => setBr((prev) => ({ ...prev, backupModal: null })),
      openRestore: () => setBr((prev) => ({ ...prev, restoreModal: 'confirm' })),
      closeRestore: () => setBr((prev) => ({ ...prev, restoreModal: null })),
      executeRestore
    }
  }
}
