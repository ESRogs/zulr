import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { errAsync, type ResultAsync } from 'neverthrow'
import type { ApiKey, Email, ZulipClient } from 'zulip-ts'
import { createClient } from 'zulip-ts'
import { clientForTeammate, type TeammateClient } from '../bot-manager.ts'
import { getErrorMessage } from '../errors.ts'
import type { ZulerDatabase } from '../state/db.ts'
import type { TeammateName } from '../tagged-types.ts'
import { NOT_CONFIGURED_MESSAGE } from './cache.ts'

export type ZulipCredentials = { site: string; email: Email; apiKey: ApiKey }

/** Credential management and Zulip client access. */
export type CredentialsContext = {
  /** Returns the admin client, or undefined if credentials aren't configured. */
  readonly getAdminClient: () => ZulipClient | undefined
  /** Get a ZulipClient and bot user ID for a registered teammate. */
  readonly getTeammateClient: (sender: TeammateName) => ResultAsync<TeammateClient, string>
  /** Returns true if Zulip credentials are configured. */
  readonly isConfigured: () => boolean
  /** Returns Zulip credentials if configured. */
  readonly getCredentials: () => ZulipCredentials | undefined
  /**
   * Try to load credentials from .env file if not already configured.
   * Calls `onReload` if new credentials are loaded, so the caller can
   * invalidate caches and start listeners.
   */
  readonly tryLoadEnv: () => void
  /** Set the callback to run when credentials are first loaded via tryLoadEnv. */
  readonly onCredentialsLoaded: (callback: () => void) => void
}

/**
 * Parse a .env file and set any missing process.env vars.
 *
 * Bun loads .env at process start, but this is needed for the lazy-load case
 * where the .env file is created after the MCP server starts (during onboarding).
 *
 * Limitations: does not handle `export` prefix, multiline values, or escaped
 * quotes. Sufficient for the three well-known ZULIP_* vars.
 */
function loadEnvFile(repoRoot: string): boolean {
  const envPath = join(repoRoot, '.env')
  try {
    // readFileSync instead of Bun.file because this is called synchronously
    const content = readFileSync(envPath, 'utf-8')
    let loaded = false
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const eqIndex = trimmed.indexOf('=')
      const key = trimmed.slice(0, eqIndex).trim()
      const rawValue = trimmed.slice(eqIndex + 1).trim()
      // Strip surrounding quotes (single or double)
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2')
      if (key && !process.env[key]) {
        process.env[key] = value
        loaded = true
      }
    }
    return loaded
  } catch {
    return false
  }
}

function getZulipCredentials(): ZulipCredentials | undefined {
  const site = process.env.ZULIP_SITE
  const email = process.env.ZULIP_EMAIL
  const apiKey = process.env.ZULIP_API_KEY
  if (!site || !email || !apiKey) return undefined
  if (!email.includes('@')) {
    throw new Error(`ZULIP_EMAIL is not a valid email address: ${email}`)
  }
  try {
    new URL(site)
  } catch {
    throw new Error(`ZULIP_SITE is not a valid URL: ${site}`)
  }
  return { site, email: email as Email, apiKey: apiKey as ApiKey }
}

export function createCredentialsContext(
  db: Kysely<ZulerDatabase>,
  repoRoot: string,
  onReload: () => void,
): CredentialsContext {
  let adminClient: ZulipClient | undefined
  let credentialsLoadedCallback: (() => void) | null = null
  let eventListenerStarted = false

  function tryGetClient(): ZulipClient | undefined {
    if (adminClient) return adminClient
    const creds = getZulipCredentials()
    if (!creds) return undefined
    adminClient = createClient(creds)
    return adminClient
  }

  return {
    getAdminClient: tryGetClient,
    isConfigured: () => !!getZulipCredentials(),
    getCredentials: getZulipCredentials,
    tryLoadEnv: () => {
      const wasConfigured = !!getZulipCredentials()
      const loaded = loadEnvFile(repoRoot)
      if (loaded && getZulipCredentials()) {
        adminClient = undefined
        onReload()
        if (!wasConfigured && !eventListenerStarted && credentialsLoadedCallback) {
          eventListenerStarted = true
          credentialsLoadedCallback()
        }
      }
    },
    onCredentialsLoaded: (callback: () => void) => {
      credentialsLoadedCallback = callback
    },
    getTeammateClient: (sender: TeammateName) => {
      const creds = getZulipCredentials()
      if (!creds) return errAsync(NOT_CONFIGURED_MESSAGE)
      return clientForTeammate(db, creds.site, sender).mapErr(getErrorMessage)
    },
  }
}
