export type InstallSourceMode = 'auto' | 'official' | 'npmmirror' | 'tencent'

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

type ConcreteInstallSource = Exclude<InstallSourceMode, 'auto'>

interface ConcreteSourceDefinition {
  id: ConcreteInstallSource
  label: string
  npmRegistry: string
  nodeMacBase?: string
}

const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org'
const NPMMIRROR_NPM_REGISTRY = 'https://registry.npmmirror.com'
const TENCENT_NPM_REGISTRY = 'https://mirrors.tencent.com/npm'
const OFFICIAL_NODE_DIST_BASE = 'https://nodejs.org/dist'
const NPMMIRROR_NODE_DIST_BASE = 'https://npmmirror.com/mirrors/node'
const TENCENT_NODE_DIST_BASE = 'https://mirrors.tencent.com/nodejs-release'
const OFFICIAL_NODE_WSL_SETUP_URL = 'https://deb.nodesource.com/setup_22.x'
const MIRROR_ELECTRON_BASE = 'https://npmmirror.com/mirrors/electron/'
export const OPENCLAW_RECOMMENDED_VERSION = '2026.4.1'

const CONCRETE_SOURCES: Record<ConcreteInstallSource, ConcreteSourceDefinition> = {
  official: {
    id: 'official',
    label: 'official',
    npmRegistry: OFFICIAL_NPM_REGISTRY,
    nodeMacBase: OFFICIAL_NODE_DIST_BASE
  },
  npmmirror: {
    id: 'npmmirror',
    label: 'npmmirror',
    npmRegistry: NPMMIRROR_NPM_REGISTRY,
    nodeMacBase: NPMMIRROR_NODE_DIST_BASE
  },
  tencent: {
    id: 'tencent',
    label: 'tencent',
    npmRegistry: TENCENT_NPM_REGISTRY,
    nodeMacBase: TENCENT_NODE_DIST_BASE
  }
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, '')

export const normalizeInstallSourceMode = (value: string | undefined): InstallSourceMode => {
  if (value === 'mirror') return 'npmmirror'
  if (value === 'official' || value === 'npmmirror' || value === 'tencent') return value
  return 'auto'
}

const getPreferredSources = (sourceMode: InstallSourceMode): ConcreteInstallSource[] => {
  switch (sourceMode) {
    case 'official':
      return ['official']
    case 'npmmirror':
      return ['npmmirror', 'official']
    case 'tencent':
      return ['tencent', 'official']
    default:
      return ['npmmirror', 'tencent', 'official']
  }
}

const buildCandidatesFromSources = <T extends SourceCandidate>(
  sourceMode: InstallSourceMode,
  buildCandidate: (source: ConcreteSourceDefinition) => T | null
): T[] => {
  const candidates: T[] = []
  const seen = new Set<string>()

  for (const sourceId of getPreferredSources(sourceMode)) {
    const source = CONCRETE_SOURCES[sourceId]
    const candidate = buildCandidate(source)
    if (!candidate || seen.has(candidate.label)) continue
    seen.add(candidate.label)
    candidates.push(candidate)
  }

  if (candidates.length === 0) {
    const officialCandidate = buildCandidate(CONCRETE_SOURCES.official)
    if (officialCandidate) {
      candidates.push(officialCandidate)
    }
  }

  return candidates
}

export const getInstallSourceSettingsFromEnv = (): InstallSourceSettings => ({
  sourceMode: normalizeInstallSourceMode(process.env.OPENCLAW_INSTALL_SOURCE_MODE)
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

  return buildCandidatesFromSources(settings.sourceMode, (source) =>
    source.nodeMacBase
      ? {
          label: source.label,
          url: `${source.nodeMacBase}/${version}/${pkgName}`
        }
      : null
  )
}

export const getNodeWslSetupCandidates = (): ScriptSourceCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()

  return buildCandidatesFromSources(settings.sourceMode, (source) =>
    source.id === 'official'
      ? {
          label: source.label,
          scriptUrl: OFFICIAL_NODE_WSL_SETUP_URL
        }
      : null
  )
}

export const getOpenclawPackageCandidates = (): OpenclawPackageCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()

  return buildCandidatesFromSources(settings.sourceMode, (source) => ({
    label: `${source.label} npm`,
    packageName: `openclaw@${OPENCLAW_RECOMMENDED_VERSION}`,
    registry: source.npmRegistry
  }))
}

export const getOpenclawMetaCandidates = (): DownloadSourceCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()

  return buildCandidatesFromSources(settings.sourceMode, (source) => ({
    label: `${source.label} npm registry`,
    url: `${normalizeBaseUrl(source.npmRegistry)}/openclaw/${OPENCLAW_RECOMMENDED_VERSION}`
  }))
}

export const getAppUpdateFeedUrl = (): string | null => {
  const settings = getInstallSourceSettingsFromEnv()
  const mirrorFeed = process.env.OPENCLAW_APP_UPDATE_MIRROR_URL?.trim()

  if (settings.sourceMode === 'official') return null
  return mirrorFeed ? normalizeBaseUrl(mirrorFeed) : null
}
