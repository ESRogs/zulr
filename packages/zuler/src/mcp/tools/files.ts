import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { Member } from 'zulip-ts'
import { downloadFile, sendDirectMessage, sendStreamMessage, uploadFile } from 'zulip-ts'
import { checkUnreadBeforeDm, checkUnreadBeforePost } from '../../zulip/unread-check.ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

export function registerUploadTool(server: McpServer, ctx: ToolContext): void {
  const { teamName } = ctx.config

  server.registerTool(
    'upload',
    {
      description:
        'Upload a file to Zulip and optionally share it in a channel or DM. Returns the file URL.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        path: z
          .string()
          .describe('Local file path to upload (relative paths resolve from repo root)'),
        channel: zChannelName.optional().describe('Channel to share the file in'),
        topic: zTopicName.optional().describe('Topic to share the file in (requires channel)'),
        to: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, name, or email to DM the file to'),
        message: z.string().optional().describe('Optional message to include with the file'),
      }),
    },
    async ({ sender, path, channel, topic, to, message }) => {
      if (topic && !channel) return errorResult('"topic" requires "channel"')
      if (channel && !topic) return errorResult('"channel" requires "topic"')
      if (channel && to !== undefined) {
        return errorResult('provide either "channel"/"topic" or "to", not both')
      }

      // Resolve DM recipient once (used for unread check + send)
      let recipient: Member | undefined
      if (to !== undefined) {
        const resolveResult = await ctx.resolveUser(to)
        if (resolveResult.isErr()) return errorResult(resolveResult.error)
        recipient = resolveResult.value
        if (recipient.is_bot) {
          return errorResult(
            'bots cannot DM other bots. Use a channel/topic for bot-to-bot communication.',
          )
        }
      }

      // Unread check before sharing
      if (channel && topic) {
        const blocked = checkUnreadBeforePost(teamName, sender, channel, topic)
        if (blocked) return errorResult(blocked)
      }
      if (recipient) {
        const dmBlocked = checkUnreadBeforeDm(teamName, sender, recipient.user_id)
        if (dmBlocked) return errorResult(dmBlocked)
      }

      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const { client } = clientResult.value

      const file = Bun.file(path)
      if (!(await file.exists())) return errorResult(`file not found: ${path}`)

      const readResult = await ResultAsync.fromPromise(
        file.arrayBuffer().then((buf) => new Uint8Array(buf)),
        (err) => (err instanceof Error ? err.message : String(err)),
      )
      if (readResult.isErr()) return errorResult(`failed to read file: ${readResult.error}`)
      const content = readResult.value

      const filename = basename(path)

      const uploadResult = await uploadFile(client, filename, content)
      if (uploadResult.isErr()) return errorResult(formatError(uploadResult.error))

      const { url } = uploadResult.value
      const fullUrl = `${client.config.site.replace(/\/+$/, '')}${url}`
      const fileLink = `[${filename}](${fullUrl})`
      const body = message ? `${message}\n\n${fileLink}` : fileLink

      if (channel && topic) {
        const postResult = await sendStreamMessage(client, { to: channel, topic, content: body })
        return postResult.match(
          (res) =>
            textResult(`uploaded and shared in ${channel}/${topic} (id: ${res.id})\n${fullUrl}`),
          (err) => errorResult(formatError(err)),
        )
      }

      if (recipient) {
        const dmResult = await sendDirectMessage(client, {
          to: [recipient.user_id],
          content: body,
        })
        return dmResult.match(
          (res) =>
            textResult(`uploaded and DM'd to ${recipient.full_name} (id: ${res.id})\n${fullUrl}`),
          (err) => errorResult(formatError(err)),
        )
      }

      return textResult(`uploaded: ${fullUrl}`)
    },
  )
}

export function registerDownloadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'download',
    {
      description:
        'Download a file from Zulip by its URL path (e.g. /user_uploads/...) and save it locally.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        url: z.string().describe('Zulip file URL path (e.g. /user_uploads/...)'),
        saveTo: z
          .string()
          .describe('Local path to save the file to (relative paths resolve from repo root)'),
      }),
    },
    async ({ sender, url: rawUrl, saveTo }) => {
      // Extract path if a full URL was passed
      const url = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl

      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const result = await downloadFile(clientResult.value.client, url)
      if (result.isErr()) return errorResult(formatError(result.error))

      const writeResult = await ResultAsync.fromPromise(
        Bun.write(saveTo, result.value.content),
        (err) => (err instanceof Error ? err.message : String(err)),
      )
      if (writeResult.isErr()) return errorResult(`failed to save file: ${writeResult.error}`)

      return textResult(
        `downloaded to ${saveTo} (${result.value.content.length} bytes, ${result.value.contentType})`,
      )
    },
  )
}
