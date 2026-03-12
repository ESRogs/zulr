import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { downloadFile, sendDirectMessage, sendStreamMessage, uploadFile } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerUploadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'upload',
    {
      description:
        'Upload a file to Zulip and optionally share it in a channel or DM. Returns the file URL.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        path: z
          .string()
          .describe('Local file path to upload (relative paths resolve from repo root)'),
        channel: z.string().optional().describe('Channel to share the file in'),
        topic: z.string().optional().describe('Topic to share the file in (requires channel)'),
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

      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const { client } = clientResult.value

      let content: Buffer
      try {
        content = readFileSync(path)
      } catch (err) {
        return errorResult(
          `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const filename = basename(path)
      const uploadResult = await uploadFile(client, filename, content)
      if (uploadResult.isErr()) return errorResult(formatError(uploadResult.error))

      const { url } = uploadResult.value
      const fileLink = `[${filename}](${url})`
      const body = message ? `${message}\n\n${fileLink}` : fileLink

      // Optionally share in a channel or DM
      if (channel && topic) {
        const postResult = await sendStreamMessage(client, { to: channel, topic, content: body })
        return postResult.match(
          (res) => textResult(`uploaded and shared in ${channel}/${topic} (id: ${res.id})\n${url}`),
          (err) => errorResult(formatError(err)),
        )
      }

      if (to !== undefined) {
        const resolveResult = await ctx.resolveUser(to)
        if (resolveResult.isErr()) return errorResult(resolveResult.error)

        const dmResult = await sendDirectMessage(client, {
          to: [resolveResult.value.user_id],
          content: body,
        })
        return dmResult.match(
          (res) =>
            textResult(
              `uploaded and DM'd to ${resolveResult.value.full_name} (id: ${res.id})\n${url}`,
            ),
          (err) => errorResult(formatError(err)),
        )
      }

      return textResult(`uploaded: ${url}`)
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
        sender: z.string().describe('Teammate name'),
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

      try {
        writeFileSync(saveTo, result.value.content)
      } catch (err) {
        return errorResult(
          `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      return textResult(
        `downloaded to ${saveTo} (${result.value.content.length} bytes, ${result.value.contentType})`,
      )
    },
  )
}
