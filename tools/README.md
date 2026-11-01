# Operator tools

## `asar-read.py` — read an installed DSH without unpacking it

The historical M1.4 host-run design required verifying the **installed** host
rather than a lockfile. The old `ffcheck plan/run` implementation is now removed
and cannot be called; these operator utilities remain useful for host-contract
and augmentation tests. The desktop app ships its dependency tree inside
`resources/app.asar`, so the running versions and exports must be inspected there.
Extracting the entire archive or adding `npx asar` is unnecessary for a small read.

```sh
python tools/asar-read.py "F:/DSH-NEXT/DSH NEXT/resources/app.asar" ls
python tools/asar-read.py ".../app.asar" cat node_modules/@deepseek-ai/dsh-tools/package.json
python tools/asar-read.py ".../app.asar" find dsh-user-approval
```

Format notes, because both are easy to get wrong and produce garbage rather than
an error:

- Bytes 0–15 are four little-endian u32s: `4`, the **aligned** header size, the
  padded payload size, and the exact JSON length.
- The JSON starts at byte 16 and runs for the **fourth** value, not the second.
- File payload offsets are relative to `8 + header_size`, not `16 + header_size`.

## `asar-closure.py` — extract the installed host for differential tests

`tests/run-augment-host.mjs` runs the **installed** `read`/`grep`/`glob` (the
real `dsh-tool-fs` and `dsh-tool-fs-search` code behind the real `dsh-tools`
registry and the bundled ripgrep) with and without forge's augmentation, and
requires the two answers to be identical. That needs those packages as files.
This extracts exactly their dependency closure — about 60 packages and 13 MB,
not the whole archive — following `dependencies`/`peerDependencies` the way
Node resolves them:

```sh
python tools/asar-closure.py ".../resources/app.asar" <dir> \
  @deepseek-ai/cordis @deepseek-ai/dsh-tools @deepseek-ai/dsh-tool-fs \
  @deepseek-ai/dsh-tool-fs-search @deepseek-ai/dsh-fs @deepseek-ai/dsh-fs-local \
  @deepseek-ai/dsh-fs-sandbox @deepseek-ai/dsh-sandbox-policy \
  @deepseek-ai/dsh-fs-observation-policy @deepseek-ai/dsh-subprocess-local \
  @vscode/ripgrep
```

Executables live beside the archive, so copy them in afterwards:
`resources/app.asar.unpacked/node_modules/@vscode/ripgrep-<platform>-<arch>`
→ `<dir>/node_modules/@vscode/`. Then set `DSH_FORGE_HOST_MODULES=<dir>/node_modules`
(and `DSH_FORGE_DSH_MODULES=<dir>/node_modules/@deepseek-ai` lets
`run-host-integration.mjs` run against the same copy).

## Current interface repair tests (2026-11-01)

`pnpm test` includes `pnpm run test:repair`. The latter runs source-importing
`run-repair-surface`, `run-repair-mutations`, `run-projects` and
`run-ledger-repair` with `node --experimental-transform-types tests/<name>.mjs`.
`node tests/run-ledger-client.mjs` bundles its TSX fixtures with esbuild in memory
(`write: false`); it is a component/request-state test, not a release build or
browser E2E test. The suite files live in [tests](../tests/), and the commands
are defined in [package.json](../package.json).

Only canonical runtime tool names are registered: `ff_find`, `ff_grep`,
`ff_symbols`, `ff_trace`, `ff_edit`, `ff_file`, `ff_history`, `ff_rollback`,
`ff_verify`, `ff_project` (retrieval 3 / full 10). Legacy-name normalization is
documentation/offline migration only; no runtime aliases. Project tool output
is `{ok, action, payload, error?}`, unlike the bare project service or flat HTTP
response. See [interface migration](../docs/forge-interface-migration-2026-11-01.md).

Updating source does not update the running GUI: build the artifacts, reload the
plugin in the host, then refresh. Local builds succeeded (including pnpm's
automatic prepare), but the host was not reloaded; generated local artifacts
do not establish deployment to the running GUI.
The existing GUI URL returned `403 Browser access disabled`, so neither deployment
nor browser E2E acceptance is claimed.
