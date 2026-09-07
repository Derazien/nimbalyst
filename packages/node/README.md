# @nimbalyst/node

Run a Nimbalyst agent session from a plain Node process. No Electron, no renderer, no sync.

This is the first consumer of `@nimbalyst/runtime`'s `node` export condition. It imports only deep
`node`-condition subpaths — never the `@nimbalyst/runtime` barrel, which drags in the whole Lexical
editor tree and is not emitted into `dist-node/` at all.

## What it does

```
nimbalyst-node --config ./nimbalyst-node.config.json \
               --workspace /path/to/repo \
               --prompt "list the files in this directory"
```

Creates (or resumes) a session, runs one Claude Code turn against the workspace, streams the output,
and persists the transcript to `ai_agent_messages` in a SQLite database with the same schema the
desktop app uses.

Add `--session <id>` to continue an existing session. The `providerSessionId` is persisted at the end
of every turn and handed back to the SDK on the next one, so a second process resumes the same
conversation rather than starting a fresh one.

## Configuration

`--config` is required and has no default. **Everything comes from that file, including credentials.
Nothing is read from `process.env`** — see the "Never Use Environment Variables as Implicit API Key
Sources" rule in the repo's `CLAUDE.md` for the incident behind that.

```json
{
  "databasePath": "./data/nimbalyst.sqlite",
  "trust": { "mode": "bypass-all" }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `databasePath` | yes | SQLite file. Relative paths resolve against the config file's directory. |
| `schemaDir` | no | Migration directory. Defaults to the in-repo copy under `packages/electron`. |
| `claudeCodePath` | no | Explicit `claude` executable. Otherwise the SDK's bundled native binary is resolved. |
| `providerApiKeys` | no | Explicitly-provisioned credentials by provider id. Claude Code needs none. |
| `trust.mode` | no | `bypass-all` (default), `allow-all`, or `ask`. |

`trust.mode` is not decoration. A headless process has nobody to answer a permission prompt, so with
no trust answer every tool call blocks forever. `ask` is expressible so the option is honest, but it
is a dead end here.

## Schema

The DDL is **not** restated in this package. `db/migrations.ts` reads the same numbered `.sql` files
`packages/electron`'s `MigrationRunner` reads, applies them through an identical `_migrations`
ledger, and `src/__tests__/migrations.test.ts` asserts the derived list matches
`getMigrations()` exactly — so the day someone adds a non-file migration this fails here rather than
producing a database that is silently a version behind.

Those files currently live only inside the Electron app package, which means an installed copy of
this package must be handed a `schemaDir`. Extracting the schema into a package both hosts depend on
is the fix, and it is not in scope for phase 0.

## Not in scope

Personal sync. There is no `SyncedSessionStore`, no index room, and nothing streams to the phone.
