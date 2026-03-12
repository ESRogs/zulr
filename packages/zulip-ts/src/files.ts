import { errAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import {
  authHeaders,
  baseUrl,
  networkError,
  parseApiResponse,
  type ZulipClient,
  type ZulipError,
} from './client.ts'
import { SuccessResponseFields } from './schemas.ts'

export type DownloadFileResponse = {
  readonly content: Uint8Array
  readonly contentType: string
}

/** Download a file from Zulip by its URL path (e.g. /user_uploads/...). */
export function downloadFile(
  client: ZulipClient,
  urlPath: string,
): ResultAsync<DownloadFileResponse, ZulipError> {
  return ResultAsync.fromPromise(
    fetch(baseUrl(client.config, urlPath), { headers: authHeaders(client.config) }),
    networkError,
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<DownloadFileResponse, ZulipError>({
        type: 'api',
        code: 'HTTP_ERROR',
        message: `HTTP ${res.status}: ${res.statusText}`,
      })
    }
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

export type UploadFileResponse = Pick<z.infer<typeof UploadFileResponseSchema>, 'url' | 'filename'>

/** Upload a file to Zulip. Returns the URL and filename for use in messages. */
export function uploadFile(
  client: ZulipClient,
  filename: string,
  content: Uint8Array,
): ResultAsync<UploadFileResponse, ZulipError> {
  const formData = new FormData()
  const blob = new Blob([content], { type: 'application/octet-stream' })
  formData.append('file', blob, filename)

  return ResultAsync.fromPromise(
    fetch(baseUrl(client.config, '/api/v1/user_uploads'), {
      method: 'POST',
      headers: authHeaders(client.config),
      body: formData,
    }),
    networkError,
  )
    .andThen((res) => {
      if (!res.ok)
        return errAsync<unknown, ZulipError>({
          type: 'api',
          code: 'HTTP_ERROR',
          message: `HTTP ${res.status}: ${res.statusText}`,
        })
      return ResultAsync.fromPromise(res.json(), networkError)
    })
    .andThen((json) => parseApiResponse(json, UploadFileResponseSchema))
    .map((data) => ({ url: data.url, filename: data.filename }))
}
