import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'

export type DownloadFileResponse = {
  readonly content: Uint8Array
  readonly contentType: string
}

/** Download a file from Zulip by its URL path (e.g. /user_uploads/...). */
export function downloadFile(
  client: ZulipClient,
  urlPath: string,
): ResultAsync<DownloadFileResponse, ZulipError> {
  const { config } = client
  const fullUrl = `${config.site.replace(/\/+$/, '')}${urlPath}`

  return ResultAsync.fromPromise(
    fetch(fullUrl, {
      headers: { Authorization: `Basic ${btoa(`${config.email}:${config.apiKey}`)}` },
    }),
    (e): ZulipError => ({
      type: 'network',
      message: e instanceof Error ? e.message : String(e),
    }),
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
      (e): ZulipError => ({
        type: 'network',
        message: e instanceof Error ? e.message : String(e),
      }),
    )
  })
}

export type UploadFileResponse = {
  readonly url: string
  readonly filename: string
}

/** Upload a file to Zulip. Returns the URL and filename for use in messages. */
export function uploadFile(
  client: ZulipClient,
  filename: string,
  content: Uint8Array | Buffer,
  contentType?: string,
): ResultAsync<UploadFileResponse, ZulipError> {
  const { config } = client
  const url = `${config.site.replace(/\/+$/, '')}/api/v1/user_uploads`

  const formData = new FormData()
  const blob = new Blob([content], { type: contentType ?? 'application/octet-stream' })
  formData.append('file', blob, filename)

  return ResultAsync.fromPromise(
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${config.email}:${config.apiKey}`)}` },
      body: formData,
    }).then((res) => res.json()),
    (e): ZulipError => ({
      type: 'network',
      message: e instanceof Error ? e.message : String(e),
    }),
  ).andThen((json: unknown) => {
    const obj = json as Record<string, unknown>
    if (obj.result === 'error') {
      return errAsync<UploadFileResponse, ZulipError>({
        type: 'api',
        code: String(obj.code ?? 'UNKNOWN'),
        message: String(obj.msg ?? 'Unknown error'),
      })
    }
    return okAsync({
      url: String(obj.url),
      filename: String(obj.filename ?? filename),
    })
  })
}
