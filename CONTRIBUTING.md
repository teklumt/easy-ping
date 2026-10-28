# Contributing

Thanks for helping. Questions and setup help go to [Discord](https://discord.gg/bJ5wGFD3H); bugs and feature requests go to [GitHub issues](https://github.com/teklumt/easy-ping/issues). For security problems, see [SECURITY.md](SECURITY.md).

## Setup

You need Node 20 or newer, pnpm 11 (`corepack enable`) and Docker for the database suites.

```sh
pnpm install
docker compose up -d   # Postgres, MySQL and MongoDB; SQLite needs nothing
```

## Before you open a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test          # database suites skip themselves when Docker is down; run them with it up
pnpm type-budget
```

If your change affects what users of the npm package see, add a changeset and describe it for them:

```sh
pnpm changeset
```

Docs live in `docs/` (`pnpm docs:dev`). A change to the public API needs its docs page updated in the same pull request; the docs build checks that every adapter and channel page stays complete.

## What gets merged

- Small, focused pull requests. Open an issue first for anything that adds public API, a new adapter, a new channel or a dependency.
- Tests for the behaviour you change. A bug fix comes with a test that fails without it.
- No new runtime dependencies without a strong reason: the package has one, and keeping it that way is a feature.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).
