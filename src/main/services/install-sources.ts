import https from 'https'

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

export interface OpenclawVersionCatalog {
  versions: string[]
  latestVersion: string | null
  recommendedVersion: string
}

interface NpmPackageMetadata {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, unknown>
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
const PACKAGE_META_TIMEOUT_MS = 8000

export const OPENCLAW_PACKAGE_NAME = 'openclaw'
export const LARK_PLUGIN_PACKAGE_NAME = '@larksuite/openclaw-lark-tools'
export const PNPM_BOOTSTRAP_PACKAGE_NAME = 'pnpm@10'
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

const packageMetadataCache = new Map<string, Promise<NpmPackageMetadata | null>>()

const normalizeBaseUrl = (value: string): string => value.replace(/\/$/, '')

export const normalizeInstallSourceMode = (value: string | undefined): InstallSourceMode => {
  if (value === 'mirror') return 'npmmirror'
  if (value === 'official' || value === 'npmmirror' || value === 'tencent') return value
  return 'auto'
}

export const normalizeOpenclawVersion = (value: string | undefined): string => {
  const trimmed = value?.trim()
  return trimmed && /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : OPENCLAW_RECOMMENDED_VERSION
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

const encodePackagePath = (packageName: string): string =>
  packageName.startsWith('@') ? packageName.replace('/', '%2F') : packageName

const fetchJson = (url: string): Promise<NpmPackageMetadata> =>
  new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (!response.statusCode || response.statusCode >= 400) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }

      let raw = ''
      response.on('data', (chunk) => {
        raw += chunk.toString('utf8')
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw) as NpmPackageMetadata)
        } catch {
          reject(new Error('parse error'))
        }
      })
    })

    request.on('error', reject)
    request.setTimeout(PACKAGE_META_TIMEOUT_MS, () => {
      request.destroy(new Error(`timeout after ${PACKAGE_META_TIMEOUT_MS}ms`))
    })
  })

const getPackageMetadataCandidates = (
  packageName: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): DownloadSourceCandidate[] =>
  buildCandidatesFromSources(sourceMode, (source) => ({
    label: `${source.label} npm metadata`,
    url: `${normalizeBaseUrl(source.npmRegistry)}/${encodePackagePath(packageName)}`
  }))

const parseVersionTuple = (value: string): [number, number, number] | null => {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export const compareVersions = (left: string, right: string): number => {
  const a = parseVersionTuple(left)
  const b = parseVersionTuple(right)
  if (!a || !b) return left.localeCompare(right)

  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }

  return 0
}

const sortVersionsDesc = (versions: string[]): string[] =>
  [...versions].sort((left, right) => compareVersions(right, left))

const fetchPackageMetadata = async (
  packageName: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): Promise<NpmPackageMetadata | null> => {
  const cacheKey = `${sourceMode}:${packageName}`
  const cached = packageMetadataCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const request = (async (): Promise<NpmPackageMetadata | null> => {
    for (const candidate of getPackageMetadataCandidates(packageName, sourceMode)) {
      try {
        const metadata = await fetchJson(candidate.url)
        if (metadata.versions || metadata['dist-tags']) {
          return metadata
        }
      } catch {
        /* try next candidate */
      }
    }

    return null
  })()

  packageMetadataCache.set(cacheKey, request)
  return request
}

const listPackageVersions = async (
  packageName: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode,
  limit = 40
): Promise<string[]> => {
  const metadata = await fetchPackageMetadata(packageName, sourceMode)
  const versions = Object.keys(metadata?.versions ?? {}).filter((value) => /^\d+\.\d+\.\d+$/.test(value))
  return sortVersionsDesc(versions).slice(0, limit)
}

export const getLatestPackageVersion = async (
  packageName: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): Promise<string | null> => {
  const metadata = await fetchPackageMetadata(packageName, sourceMode)
  const latestTag = metadata?.['dist-tags']?.latest?.trim()
  if (latestTag && /^\d+\.\d+\.\d+$/.test(latestTag)) {
    return latestTag
  }

  const versions = await listPackageVersions(packageName, sourceMode, 1)
  return versions[0] ?? null
}

export const getOpenclawVersionCatalog = async (
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): Promise<OpenclawVersionCatalog> => {
  const versions = await listPackageVersions(OPENCLAW_PACKAGE_NAME, sourceMode, 60)
  const latestVersion = await getLatestPackageVersion(OPENCLAW_PACKAGE_NAME, sourceMode)

  const normalizedVersions = new Set(versions)
  normalizedVersions.add(OPENCLAW_RECOMMENDED_VERSION)
  if (latestVersion) normalizedVersions.add(latestVersion)

  return {
    versions: sortVersionsDesc([...normalizedVersions]).slice(0, 60),
    latestVersion,
    recommendedVersion: OPENCLAW_RECOMMENDED_VERSION
  }
}

const resolveCompatiblePackageVersion = async (
  packageName: string,
  targetVersion: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): Promise<string> => {
  const versions = await listPackageVersions(packageName, sourceMode, 120)
  if (versions.length === 0) return targetVersion
  if (versions.includes(targetVersion)) return targetVersion

  const compatibleVersion = versions.find((version) => compareVersions(version, targetVersion) <= 0)
  return compatibleVersion ?? versions[0] ?? targetVersion
}

export const getCompatibleLarkPluginPackageSpec = async (
  openclawVersion: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): Promise<string> => {
  const compatibleVersion = await resolveCompatiblePackageVersion(
    LARK_PLUGIN_PACKAGE_NAME,
    openclawVersion,
    sourceMode
  )
  return `${LARK_PLUGIN_PACKAGE_NAME}@${compatibleVersion}`
}

export const getCompatibleLarkPluginPackageCandidates = async (
  openclawVersion: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): Promise<OpenclawPackageCandidate[]> => {
  const candidates: OpenclawPackageCandidate[] = []
  const seen = new Set<string>()

  for (const sourceId of getPreferredSources(sourceMode)) {
    const source = CONCRETE_SOURCES[sourceId]
    const compatibleVersion = await resolveCompatiblePackageVersion(
      LARK_PLUGIN_PACKAGE_NAME,
      openclawVersion,
      source.id
    )
    const packageName = `${LARK_PLUGIN_PACKAGE_NAME}@${compatibleVersion}`
    const key = `${source.label}:${packageName}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      label: `${source.label} npm`,
      packageName,
      registry: source.npmRegistry
    })
  }

  if (candidates.length === 0) {
    candidates.push({
      label: 'official npm',
      packageName: `${LARK_PLUGIN_PACKAGE_NAME}@${openclawVersion}`,
      registry: OFFICIAL_NPM_REGISTRY
    })
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

const getRegistryPackageCandidates = (
  packageName: string,
  sourceMode = getInstallSourceSettingsFromEnv().sourceMode
): OpenclawPackageCandidate[] =>
  buildCandidatesFromSources(sourceMode, (source) => ({
    label: `${source.label} npm`,
    packageName,
    registry: source.npmRegistry
  }))

export const getPnpmPackageCandidates = (
  packageName = PNPM_BOOTSTRAP_PACKAGE_NAME
): OpenclawPackageCandidate[] => getRegistryPackageCandidates(packageName)

export const getOpenclawPackageCandidates = (
  version = OPENCLAW_RECOMMENDED_VERSION
): OpenclawPackageCandidate[] => {
  const settings = getInstallSourceSettingsFromEnv()
  const normalizedVersion = normalizeOpenclawVersion(version)

  return getRegistryPackageCandidates(
    `${OPENCLAW_PACKAGE_NAME}@${normalizedVersion}`,
    settings.sourceMode
  )
}

export const getOpenclawMetaCandidates = (): DownloadSourceCandidate[] =>
  getPackageMetadataCandidates(OPENCLAW_PACKAGE_NAME)

export const getAppUpdateFeedUrl = (): string | null => {
  const settings = getInstallSourceSettingsFromEnv()
  const mirrorFeed = process.env.OPENCLAW_APP_UPDATE_MIRROR_URL?.trim()

  if (settings.sourceMode === 'official') return null
  return mirrorFeed ? normalizeBaseUrl(mirrorFeed) : null
}
