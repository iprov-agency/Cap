1. npx tsc --noEmit (fix type errors if any)
2. npx @biomejs/biome check --no-errors-on-unmatched (fix lint/format errors if any, only on files you changed)
3. Self-review: check for unused imports, any types, accidental console.log
4. Write results to /context/verification.json

IMPORTANT: Do NOT run npm run build, pnpm build, next build, or turbo run build.
The Next.js monorepo build exceeds container memory. Typecheck and lint are sufficient.
Do NOT run npm test or turbo run test. The test runner is not available in this container.
Do NOT commit or stage .pnpm-store, node_modules, package-lock.json, or app.config.timestamp* files.
