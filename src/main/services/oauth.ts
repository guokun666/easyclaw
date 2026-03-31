import { shell } from 'electron'
import { randomBytes, createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { platform, homedir } from 'os'
import { readWslFile, writeWslFile, runInWsl } from './wsl-utils'

// OpenAI OAuth constants (from OpenClaw's pi-ai)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = 'openid profile email offline_access'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const CALLBACK_PORT = 1455

// Auth profile store path
const AUTH_PROFILE_FILENAME = 'auth-profiles.json'
const OAUTH_PROFILE_ID = 'openai-codex:default'

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>OK</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#fff">
<p>Authentication successful. You can close this window.</p>
</body></html>`

// PKCE helpers
const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const generatePKCE = (): { verifier: string; challenge: string } => {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// JWT decode (no verification, just payload)
const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64').toString())
  } catch {
    return null
  }
}

// Build authorization URL
const buildAuthUrl = (challenge: string, state: string): string => {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'pi')
  return url.toString()
}

// Exchange authorization code for tokens
const exchangeCode = async (
  code: string,
  verifier: string
): Promise<{ access: string; refresh: string; expires: number }> => {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('Token response missing required fields')
  }
  return {
    access: json.access_token as string,
    refresh: json.refresh_token as string,
    expires: Date.now() + (json.expires_in as number) * 1000
  }
}

// Start local OAuth callback server
const startCallbackServer = (
  expectedState: string
): Promise<{ server: Server; waitForCode: () => Promise<string | null> }> => {
  return new Promise((resolve) => {
    let codeResolve: ((code: string | null) => void) | null = null

    const server = createServer((req, res) => {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      if (url.searchParams.get('state') !== expectedState) {
        res.statusCode = 400
        res.end('State mismatch')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.statusCode = 400
        res.end('Missing code')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(SUCCESS_HTML)
      codeResolve?.(code)
    })

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      resolve({
        server,
        waitForCode: () =>
          new Promise<string | null>((r) => {
            codeResolve = r
            // Timeout after 120 seconds
            setTimeout(() => r(null), 120_000)
          })
      })
    })

    server.on('error', (err) => {
      console.error('[OAuth] Failed to bind callback server:', err)
      resolve({
        server,
        waitForCode: () => Promise.resolve(null)
      })
    })

    // Allow external cancellation
    server.once('close', () => {
      codeResolve?.(null)
    })
  })
}

// Save OAuth credentials to OpenClaw auth-profiles.json
const saveCredentials = async (creds: {
  access: string
  refresh: string
  expires: number
  accountId: string
}): Promise<void> => {
  const isWindows = platform() === 'win32'
  const credential = {
    type: 'oauth',
    provider: 'openai-codex',
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId
  }
  if (isWindows) {
    // WSL: read/write via wsl-utils
    const wslDir = '/root/.openclaw/agents/main/agent'
    const wslPath = wslDir + '/' + AUTH_PROFILE_FILENAME
    await runInWsl(`mkdir -p '${wslDir}'`)
    let store: Record<string, unknown>
    try {
      const raw = await readWslFile(wslPath)
      store = JSON.parse(raw)
    } catch {
      store = { version: 1, profiles: {} }
    }
    const profiles = (store.profiles ?? {}) as Record<string, unknown>
    profiles[OAUTH_PROFILE_ID] = credential
    store.profiles = profiles
    await writeWslFile(wslPath, JSON.stringify(store, null, 2))
  } else {
    // macOS/Linux: direct file access
    const agentDir = join(homedir(), '.openclaw', 'agents', 'main', 'agent')
    const filePath = join(agentDir, AUTH_PROFILE_FILENAME)
    mkdirSync(agentDir, { recursive: true })
    let store: Record<string, unknown>
    try {
      store = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      store = { version: 1, profiles: {} }
    }
    const profiles = (store.profiles ?? {}) as Record<string, unknown>
    profiles[OAUTH_PROFILE_ID] = credential
    store.profiles = profiles
    writeFileSync(filePath, JSON.stringify(store, null, 2))
  }
}

export const loginOpenAICodex = async (): Promise<void> => {
  const { verifier, challenge } = generatePKCE()
  const state = randomBytes(16).toString('hex')
  const authUrl = buildAuthUrl(challenge, state)

  // Start callback server
  const { server, waitForCode } = await startCallbackServer(state)

  let resolved = false
  const cleanup = (): void => {
    if (resolved) return
    resolved = true
    server.close()
  }

  try {
    // Open the OAuth flow in the system browser. OpenAI auth is more reliable
    // there than inside an embedded Electron webview.
    await shell.openExternal(authUrl)

    const code = await waitForCode()
    if (!code) {
      cleanup()
      throw new Error('cancelled')
    }

    // Exchange code for tokens
    const tokens = await exchangeCode(code, verifier)

    // Extract accountId from JWT
    const payload = decodeJwtPayload(tokens.access)
    const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined
    const accountId = auth?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId) {
      cleanup()
      throw new Error('Failed to extract accountId from token')
    }

    // Save to OpenClaw auth profile store
    await saveCredentials({
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId
    })

    cleanup()
  } catch (err) {
    cleanup()
    throw err
  }
}
