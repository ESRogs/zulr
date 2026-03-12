import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { baseUrl, encodeAuth, type ZulipClient, type ZulipError } from './client.ts'
import { SuccessResponseFields } from './schemas.ts'

export type DownloadFileResponse = {
  readonly content: Uint8Array
  readonly contentType: string
}

const networkError = (e: unknown): ZulipError => ({
  type: 'network',
  message: e instanceof Error ? e.message : String(e),
})

const httpError = (res: Response): ZulipError => ({
  type: 'api',
  code: 'HTTP_ERROR',
  message: `HTTP ${res.status}: ${res.statusText}`,
})

function authHeaders(client: ZulipClient): Record<string, string> {
  return { Authorization: `Basic ${encodeAuth(client.config)}` }
}

/** Download a file from Zulip by its URL path (e.g. /user_uploads/...). */
export function downloadFile(
  client: ZulipClient,
  urlPath: string,
): ResultAsync<DownloadFileResponse, ZulipError> {
  return ResultAsync.fromPromise(
    fetch(baseUrl(client.config, urlPath), { headers: authHeaders(client) }),
    networkError,
  ).andThen((res) => {
    if (!res.ok) return errAsync<DownloadFileResponse, ZulipError>(httpError(res))
    return ResultAsync.fromPromise(
      res.arrayBuffer().then((buf) => ({
        content: new Uint8Array(buf),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      })),
      networkError,
    )
  })
}

const UploadFileResponseSchema = z.object({
  ...SuccessResponseFields,
  url: z.string(),
  filename: z.string(),
})

export type UploadFileResponse = {
  readonly url: string
  readonly filename: string
}

/** Upload a file to Zulip. Returns the URL and filename for use in messages. */
export function uploadFile(
  client: ZulipClient,
  filename: string,
  content: Uint8Array | Buffer,
): ResultAsync<UploadFileResponse, ZulipError> {
  const formData = new FormData()
  const blob = new Blob([content], { type: 'application/octet-stream' })
  formData.append('file', blob, filename)

  return ResultAsync.fromPromise(
    fetch(baseUrl(client.config, '/api/v1/user_uploads'), {
      method: 'POST',
      headers: authHeaders(client),
      body: formData,
    }),
    networkError,
  )
    .andThen((res) => {
      if (!res.ok) return errAsync<unknown, ZulipError>(httpError(res))
      return ResultAsync.fromPromise(res.json(), networkError)
    })
    .andThen((json: unknown) => {
      const parsed = UploadFileResponseSchema.safeParse(json)
      if (!parsed.success) {
        return errAsync<UploadFileResponse, ZulipError>({
          type: 'validation',
          message: parsed.error.message,
        })
      }
      return okAsync({ url: parsed.data.url, filename: parsed.data.filename })
    })
}
