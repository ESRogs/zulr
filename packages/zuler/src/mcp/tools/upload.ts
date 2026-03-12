import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendDirectMessage, sendStreamMessage, uploadFile } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.log': 'text/plain',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.py': 'text/plain',
}

export function registerUploadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'upload',
    {
      description:
        'Upload a file to Zulip and optionally share it in a channel or DM. Returns the file URL.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        path: z.string().describe('Local file path to upload'),
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
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const { client } = clientResult.value

      let content: Buffer
      try {
        content = readFileSync(path) as Buffer
      } catch (err) {
        return errorResult(
          `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const filename = basename(path)
      const contentType = MIME_TYPES[extname(path).toLowerCase()]

      const uploadResult = await uploadFile(client, filename, content, contentType)
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
