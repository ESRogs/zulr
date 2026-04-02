import stringify from 'fast-safe-stringify'

type ErrorWithMessage = {
  readonly message: string
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  )
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
  return isErrorWithMessage(maybeError) ? maybeError : new Error(stringify(maybeError))
}

export function getErrorMessage(error: unknown): string {
  return toErrorWithMessage(error).message
}
