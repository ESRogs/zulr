import { ResultAsync } from 'neverthrow'

export type StateError =
  | { readonly type: 'not_found'; readonly message: string }
  | { readonly type: 'already_exists'; readonly message: string }
  | { readonly type: 'db_error'; readonly message: string }

export class NotFoundError extends Error {}
export class AlreadyExistsError extends Error {}

export function wrapDbError(e: unknown): StateError {
  if (e instanceof NotFoundError) return { type: 'not_found', message: e.message }
  if (e instanceof AlreadyExistsError) return { type: 'already_exists', message: e.message }
  return { type: 'db_error', message: e instanceof Error ? e.message : String(e) }
}

/** Wrap a DB operation, catching promise rejections as StateError. */
export function dbOp<T>(fn: () => Promise<T>): ResultAsync<T, StateError> {
  return ResultAsync.fromPromise(fn(), wrapDbError)
}
