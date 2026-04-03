import { describe, it } from 'bun:test'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { rules } from '../must-use-result.js'

const rule = rules['must-use-result']

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['*.ts'],
        defaultProject: 'tsconfig.json',
      },
      tsconfigRootDir: import.meta.dirname,
    },
  },
})

RuleTester.afterAll = () => {}
RuleTester.describe = (text, fn) => describe(text, fn)
RuleTester.it = (text, fn) => it(text, fn)

// Inline Result-like type so tests don't depend on neverthrow being resolvable
// from the test tsconfig. The rule identifies Result types by property presence
// (mapErr, map, andThen, orElse, match, unwrapOr), not by import source.
const resultTypePreamble = `
type Result<T, E> = {
  map<U>(fn: (v: T) => U): Result<U, E>
  mapErr<F>(fn: (e: E) => F): Result<T, F>
  andThen<U>(fn: (v: T) => Result<U, E>): Result<U, E>
  orElse<F>(fn: (e: E) => Result<T, F>): Result<T, F>
  match<U>(ok: (v: T) => U, err: (e: E) => U): U
  unwrapOr(fallback: T): T
  isErr(): boolean
  isOk(): boolean
  _unsafeUnwrap(): T
  value: T
  error: E
}
declare function makeResult(): Result<number, string>
`

ruleTester.run('must-use-result', rule, {
  valid: [
    // .match() is recognized
    {
      code: `${resultTypePreamble}
        function test(): void {
          const result = makeResult()
          result.match(
            (v) => console.log(v),
            (e) => console.error(e),
          )
        }
      `,
    },
    // .isErr() guard is recognized
    {
      code: `${resultTypePreamble}
        function test(): string {
          const result = makeResult()
          if (result.isErr()) return result.error
          return String(result.value)
        }
      `,
    },
    // .isOk() guard is recognized
    {
      code: `${resultTypePreamble}
        function test(): void {
          const result = makeResult()
          if (result.isOk()) console.log(result.value)
        }
      `,
    },
    // .unwrapOr() is recognized
    {
      code: `${resultTypePreamble}
        function test(): number {
          const result = makeResult()
          return result.unwrapOr(0)
        }
      `,
    },
    // Returned Result is not flagged
    {
      code: `${resultTypePreamble}
        function test(): Result<number, string> {
          return makeResult()
        }
      `,
    },
  ],
  invalid: [
    // Completely ignored Result
    {
      code: `${resultTypePreamble}
        function test(): void {
          const result = makeResult()
        }
      `,
      errors: [{ messageId: 'mustUseResult' }],
    },
    // Result used but never handled (only accessing .value without guard)
    {
      code: `${resultTypePreamble}
        function test(): void {
          makeResult()
        }
      `,
      errors: [{ messageId: 'mustUseResult' }],
    },
    // .mapErr() fire-and-forget is still flagged (not in handledMethods).
    // Two errors: one for makeResult() and one for the .mapErr() chain result.
    {
      code: `${resultTypePreamble}
        function test(): void {
          makeResult().mapErr((e) => console.error(e))
        }
      `,
      errors: [{ messageId: 'mustUseResult' }, { messageId: 'mustUseResult' }],
    },
  ],
})
