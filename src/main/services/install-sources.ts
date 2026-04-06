export type InstallSourceMode = 'auto' | 'official' | 'mirror'

export interface InstallSourceSettings {
  sourceMode: InstallSourceMode
}

interface SourceCandidate {
  label: string
}

export interface DownloadSourceCandidate extends SourceCandidate {
  url: string
}

export interface ScriptSourceCandidate extends SourceCandidate {
  scriptUrl: string
}

export interface OpenclawPackageCandidate extends SourceCandidate {
  packageName: string
  registry: string
}

const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org'
const MIRROR_NPM_REGISTRY = 'https://registry.npmmirror.com'
const OFFICIAL_NODE_DIST_BASE = 'https://nodejs.org/dist'
const MIRROR_NODE_DIST_BASE = 'https://npmmirror.com/mirrors/node'
const OFFICIAL_NODE_WSL_SETUP_URL = 'https://deb.nodesource.com/setup_22.x'
const MIRROR_ELECTRON_BASE = 'https://npmmirror.com/mirrors/electron/'
export const OPENCLAW_RECOMMENDED_VERSION = '2026.4.1'

const normalizeSourceMode = (value: string | undefined): InstallSourceMode => {
  if (value === 'official' || value === 'mirror') return value
  return 'auto'
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, '')

const orderCandidates = <T extends SourceCandidate>(
  sourceMode: InstallSourceMode,
  official: T,
  mirror?: T | null
): T[] => {
  if (sourceMode === 'official') return [official]
  if (sourceMode === 'mirror') return mirror ? [mirror] : [official]
  return mirror ? [mirror, official] : [official]
}

export const getInstallSourceSettingsFromEnv = (): InstallSourceSettings => ({
  sourceMode: normalizeSourceMode(process.env.OPENCLAW_INSTALL_SOURCE_MODE)
})

export const getElectronMirror = (): string => MIRROR_ELECTRON_BASE

export const getNpmCommandEnv = (
  registry: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => ({
  ...baseEnv,
  npm_config_registry: registry
})

export const getNodeMacDownloadCandidates = (version: string): DownloadSourceCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()
  const pkgName = `node-${version}.pkg`
  const official = {
    label: 'official',
    url: `${OFFICIAL_NODE_DIST_BASE}/${version}/${pkgName}`
  }
  const mirror = {
    label: 'mirror',
    url: `${MIRROR_NODE_DIST_BASE}/${version}/${pkgName}`
  }

  return orderCandidates(settings.sourceMode, official, mirror)
}

export const getNodeWslSetupCandidates = (): ScriptSourceCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()
  const official = {
    label: 'official',
    scriptUrl: OFFICIAL_NODE_WSL_SETUP_URL
  }

  return orderCandidates(settings.sourceMode, official)
}

export const getOpenclawPackageCandidates = (): OpenclawPackageCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()
  const official: OpenclawPackageCandidate = {
    label: 'official npm',
    packageName: `openclaw@${OPENCLAW_RECOMMENDED_VERSION}`,
    registry: OFFICIAL_NPM_REGISTRY
  }
  const mirror: OpenclawPackageCandidate = {
    label: 'mirror npm',
    packageName: `openclaw@${OPENCLAW_RECOMMENDED_VERSION}`,
    registry: MIRROR_NPM_REGISTRY
  }

  return orderCandidates(settings.sourceMode, official, mirror)
}

export const getOpenclawMetaCandidates = (): DownloadSourceCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()
  const official = {
    label: 'official npm registry',
    url: `${OFFICIAL_NPM_REGISTRY}/openclaw/${OPENCLAW_RECOMMENDED_VERSION}`
  }
  const mirror = {
    label: 'mirror npm registry',
    url: `${MIRROR_NPM_REGISTRY}/openclaw/${OPENCLAW_RECOMMENDED_VERSION}`
  }

  return orderCandidates(settings.sourceMode, official, mirror)
}

export const getAppUpdateFeedUrl = (): string | null => {
  const settings = getInstallSourceSettingsFromEnv()
  const mirrorFeed = process.env.OPENCLAW_APP_UPDATE_MIRROR_URL?.trim()

  if (settings.sourceMode === 'official') return null
  return mirrorFeed ? normalizeBaseUrl(mirrorFeed) : null
}
