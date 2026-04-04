import stringify from 'fast-safe-stringify'

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as Record<string, unknown>).message
    if (typeof msg === 'string') return msg
  }
  return stringify(error)
}
