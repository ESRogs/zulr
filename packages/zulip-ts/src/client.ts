import { err, ok, type Result, ResultAsync } from 'neverthrow'
import type { z } from 'zod'
import type { Email } from './tagged-types.ts'

export type ZulipConfig = {
  readonly site: string
  readonly email: Email
  readonly apiKey: string
}

export type ZulipError =
  | { readonly type: 'network'; readonly message: string }
  | { readonly type: 'api'; readonly code: string; readonly message: string }
  | { readonly type: 'validation'; readonly message: string }

type RequestOptions = {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PATCH'
  readonly path: string
  readonly params?: Record<string, string | number | boolean>
  readonly body?: Record<string, unknown>
}

export const networkError = (e: unknown): ZulipError => ({
  type: 'network',
  message: e instanceof Error ? e.message : String(e),
})

export const encodeAuth = (config: ZulipConfig): string => btoa(`${config.email}:${config.apiKey}`)

export const baseUrl = (config: ZulipConfig, path: string): string =>
  `${config.site.replace(/\/+$/, '')}${path}`

export function authHeaders(config: ZulipConfig): Readonly<Record<string, string>> {
  return { Authorization: `Basic ${encodeAuth(config)}` }
}

export function httpError(res: Response): ZulipError {
  return { type: 'api', code: 'HTTP_ERROR', message: `HTTP ${res.status}: ${res.statusText}` }
}

/** Check for Zulip API-level errors and validate against a zod schema. */
export function parseApiResponse<T>(json: unknown, schema: z.ZodType<T>): Result<T, ZulipError> {
  const obj = json as Record<string, unknown>
  if (obj.result === 'error') {
    return err({
      type: 'api',
      code: String(obj.code ?? 'UNKNOWN'),
      message: String(obj.msg ?? 'Unknown error'),
    })
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return err({ type: 'validation', message: parsed.error.message })
  }
  return ok(parsed.data)
}

const buildUrl = (
  config: ZulipConfig,
  path: string,
  params?: Record<string, string | number | boolean>,
): string => {
  const base = baseUrl(config, `/api/v1${path}`)
  if (!params || Object.keys(params).length === 0) return base
  const search = new URLSearchParams(
    Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
  )
  return `${base}?${search.toString()}`
}

const buildFormBody = (body: Record<string, unknown>): URLSearchParams =>
  new URLSearchParams(
    Object.entries(body).map(([k, v]): [string, string] => [
      k,
      typeof v === 'string' ? v : JSON.stringify(v),
    ]),
  )

/** Make a validated request to the Zulip API. */
const request = <T>(
  config: ZulipConfig,
  options: RequestOptions,
  schema: z.ZodType<T>,
): ResultAsync<T, ZulipError> => {
  const { method, path, params, body } = options
  const url = buildUrl(config, path, method === 'GET' ? params : undefined)

  const fetchBody =
    method !== 'GET' && body
      ? buildFormBody(body)
      : method !== 'GET' && params
        ? buildFormBody(params as Record<string, unknown>)
        : undefined

  const headers: Readonly<Record<string, string>> = {
    ...authHeaders(config),
    ...(fetchBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
  }

  return ResultAsync.fromPromise(
    fetch(url, { method, headers, body: fetchBody }).then((res) => res.json()),
    networkError,
  ).andThen((json: unknown) => parseApiResponse(json, schema))
}

export type ZulipClient = {
  readonly config: ZulipConfig
  readonly request: <T>(options: RequestOptions, schema: z.ZodType<T>) => ResultAsync<T, ZulipError>
}

export function createClient(config: ZulipConfig): ZulipClient {
  return {
    config,
    request: (options, schema) => request(config, options, schema),
  }
}
