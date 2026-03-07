import { errAsync, ResultAsync } from 'neverthrow'
import type { z } from 'zod'

export type ZulipConfig = {
  readonly site: string
  readonly email: string
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

const encodeAuth = (config: ZulipConfig): string => btoa(`${config.email}:${config.apiKey}`)

const buildUrl = (
  config: ZulipConfig,
  path: string,
  params?: Record<string, string | number | boolean>,
): string => {
  const base = `${config.site.replace(/\/+$/, '')}/api/v1${path}`
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
    Authorization: `Basic ${encodeAuth(config)}`,
    ...(fetchBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
  }

  return ResultAsync.fromPromise(
    fetch(url, { method, headers, body: fetchBody }).then((res) => res.json()),
    (e): ZulipError => ({
      type: 'network',
      message: e instanceof Error ? e.message : String(e),
    }),
  ).andThen((json: unknown) => {
    // Check for Zulip-level errors before schema validation
    const obj = json as Record<string, unknown>
    if (obj.result === 'error') {
      return errAsync<T, ZulipError>({
        type: 'api',
        code: String(obj.code ?? 'UNKNOWN'),
        message: String(obj.msg ?? 'Unknown error'),
      })
    }

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      return errAsync<T, ZulipError>({
        type: 'validation',
        message: parsed.error.message,
      })
    }
    return ResultAsync.fromSafePromise(Promise.resolve(parsed.data))
  })
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
