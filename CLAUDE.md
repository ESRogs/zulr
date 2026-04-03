
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Git

- Default to squash merge when merging PRs: `gh pr merge --squash --delete-branch`
- **Never merge PRs without the user's explicit approval.** Create the PR, then wait.

## Project Conventions

### Libraries

- **neverthrow** for error handling — use `Result`/`ResultAsync` and `err`/`ok` instead of try/catch. Errors are values in the return type. See "Error Handling" section below.
- **zod** for runtime validation and schema definition — use at all external boundaries (API responses, env vars, config files, MCP tool inputs).
- **type-fest** for utility types — prefer its types over rolling your own (`JsonValue`, `Simplify`, `SetOptional`, etc.).

### Style

- Functional + statically typed. Standalone functions over classes. No inheritance.
- Prefer functional patterns (`map`, `filter`, `flatMap`, `reduce`) for data transformations. Use imperative loops (`for`, `while`) when they're genuinely clearer — e.g., complex accumulation with early exits, side effects, or async/await in the loop body. Readability drives the choice.
- Use `function` declarations for named/exported functions, not arrow `const`. Arrow functions are fine for inline callbacks and small helpers.
- Type annotations at all function boundaries. No `any`.
- Single quotes in TypeScript files.
- **Biome** for linting and formatting. Run `bunx biome check --fix` to auto-fix.
- **ESLint** for neverthrow's `must-use-result` rule only. Run `bunx eslint` to check. See "Error Handling" below.
- File names lowercase kebab-case (e.g., `zulip-client.ts`, not `ZulipClient.ts`).

### Error Handling

Every `Result` and `ResultAsync` must be explicitly handled. Never silently discard errors.

**Preferred: use `.match()` to handle both paths in one expression:**
```ts
return result.match(
  (value) => textResult(value),
  (err) => errorResult(formatError(err)),
)
```

**Also acceptable: `.isErr()` guard pattern** when the error path returns early:
```ts
const result = await someCall()
if (result.isErr()) return errorResult(result.error)
// result.value is narrowed to the success type here
```

**For fire-and-forget side effects**, use `.mapErr()` to log errors:
```ts
markAsRead(client, [id]).mapErr((err) => onError?.(err))
```

**Other valid handlers:** `.andThen()`, `.orElse()`, `.map()`, `.mapErr()` chains, `.unwrapOr()`.

**ESLint `must-use-result` rule:** The vendored `neverthrow/must-use-result` rule (in `eslint-plugins/`) catches unhandled Results. It recognizes `.match()`, `.unwrapOr()`, `._unsafeUnwrap()`, `.isErr()`, and `.isOk()` as valid handlers. A few edge cases still need `// eslint-disable-next-line neverthrow/must-use-result` comments: `.mapErr()` fire-and-forget, `Promise.all` destructuring, and `(await expr).unwrapOr()`. Before adding a suppression, confirm that errors are returned, logged, or intentionally discarded — never silently swallowed.
