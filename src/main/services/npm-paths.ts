import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { app } from 'electron'

const ensureDir = (path: string): string => {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

const getManagedRootDir = (): string => {
  try {
    return ensureDir(join(app.getPath('userData'), 'npm'))
  } catch {
    return ensureDir(join(homedir(), '.easyclaw-installer', 'npm'))
  }
}

export const getManagedNpmPaths = (): {
  rootDir: string
  prefixDir: string
  cacheDir: string
  binDir: string
  storeDir: string
} => {
  const rootDir = getManagedRootDir()
  const prefixDir = ensureDir(join(rootDir, 'global'))
  const cacheDir = ensureDir(join(rootDir, 'cache'))
  const binDir = ensureDir(join(prefixDir, 'bin'))
  const storeDir = ensureDir(join(rootDir, 'store'))

  return {
    rootDir,
    prefixDir,
    cacheDir,
    binDir,
    storeDir
  }
}

export const getManagedNpmEnv = (baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { prefixDir, cacheDir, binDir, storeDir } = getManagedNpmPaths()

  return {
    ...baseEnv,
    npm_config_prefix: prefixDir,
    npm_config_cache: cacheDir,
    PNPM_HOME: binDir,
    PNPM_STORE_DIR: storeDir,
    PATH: [binDir, baseEnv.PATH ?? ''].filter(Boolean).join(delimiter)
  }
}

export const getManagedBinPath = (name: string): string => join(getManagedNpmPaths().binDir, name)

export const hasManagedBin = (name: string): boolean => existsSync(getManagedBinPath(name))
