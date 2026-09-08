# Repository Guidelines

## Project Structure & Module Organization

- `app.js` is the application entry point and initialization coordinator.
- `lib/server/http/` contains Express routes, controllers, and middleware; `lib/server/socket.io/` contains the real-time protocol.
- `lib/chat/` holds LLM adapters, task execution, OneBot, ACP, and memory services. Cross-cutting lifecycle logic belongs in `lib/hooks/`.
- Built-in plugins live in `lib/plugins/`; third-party workspace plugins belong in `plugins/custom/<name>/`.
- Channel integrations are under `channels/`; shared helpers are in `utils/`; operational scripts are in `scripts/`.
- The Prisma schema is `prisma/schema.prisma`. Tests are organized under `tests/{adapters,channels,integration,plugins,push,routes,triggers,unit}/`. Treat `dist/` as generated output.

## Build, Test, and Development Commands

Use Node.js 20.19+ (or the versions declared in `package.json`) and pnpm.

```bash
pnpm install             # Install dependencies and generate Prisma client
pnpm dev                 # Run app.js with file watching
pnpm lint                # Run oxlint
pnpm format              # Format files with Prettier
pnpm test:unit           # Run Node's unit test suite
pnpm test                # Run the integration/OneBot test script
pnpm db:push             # Sync schema changes to the development database
pnpm docker:build        # Build the backend image
```

`pnpm test` expects a running service at `http://localhost:3080`; set `BASE_URL` and `ADMIN_CODE` when needed.

## Coding Style & Naming Conventions

Use ES modules (`import`/`export`), two-space indentation, no semicolons, single quotes, trailing commas, and an 80-column print width; these rules are enforced by `.prettierrc`. Use `PascalCase` for classes, `camelCase` for functions and variables, and descriptive lowercase filenames. Preserve the existing dynamic-import patterns and use the shared `logger` for runtime logging.

## Testing Guidelines

Tests use Node's built-in `node:test` API; there is no third-party test framework or stated coverage threshold. Name files `*.test.js`, place them beside the relevant subsystem category, and run the narrowest applicable command during development, for example `node --test tests/channels/channel_runtime.test.js`.

## Security & Configuration

Do not commit `.env` files, database files, runtime channel data, or credentials. Application configuration is persisted in SQLite (`data/app.db`) and exposed through the existing services/API. After schema changes, update the relevant service layer and run `pnpm db:push` locally.

## Commit & Pull Request Guidelines

Follow the repository's history with concise Conventional Commit-style messages such as `feat(channel): ...`, `fix: ...`, or `docs: ...`. Keep commits focused. The project notes allow direct work on `master`; when a pull request is used, describe behavior changes, test commands/results, schema or configuration impact, and any required frontend protocol coordination.

> [!IMPORTANT]
> **Upstream Dependency & Branch Release Gate (OneBots Patch)**:
> The backend WeChat integration on `codex/onebots-wechat-migration` relies on a custom patch (`patches/@onebots__adapter-wechat-clawbot@3.0.12.patch`).
> **DO NOT merge this branch into `master` or release `master`** until the upstream `onebots` repository merges our PR and officially publishes the new version to npm. Once published upstream, remove `patchedDependencies` from `package.json`, bump the dependency, verify all tests, and only then proceed with merging to `master`.

