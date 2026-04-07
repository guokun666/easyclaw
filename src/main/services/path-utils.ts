import { existsSync } from 'fs'
import { platform } from 'os'
import { join } from 'path'
import { getManagedBinPath, getManagedNpmPaths, hasManagedBin } from './npm-paths'

const getPathDirs = (): string[] =>
  [
    getManagedNpmPaths().binDir,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    process.env.NVM_BIN ?? '',
    `${process.env.HOME}/.volta/bin`,
    `${process.env.HOME}/.npm-global/bin`
  ].filter(Boolean)

export const getPathEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...getPathDirs(), process.env.PATH ?? ''].join(':')
  }
  // Prevent MODULE_NOT_FOUND from referencing deleted ipv4-fix.js
  delete env.NODE_OPTIONS
  return env
}

export const findBin = (name: string): string => {
  if (platform() === 'win32') return name
  for (const dir of getPathDirs()) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return name
}

export const resolvePreferredBin = (name: string): string => {
  if (platform() === 'win32') return name
  if (hasManagedBin(name)) return getManagedBinPath(name)
  return findBin(name)
}
