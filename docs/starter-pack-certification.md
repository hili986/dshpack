# Starter Pack Certification — W15b

Certification date: 2026-08-17.  All `dsh` invocations used an explicitly supplied, isolated `DSH_HOME`; no user DSH home was read or written.

Raw Windows stdout, stderr, and exit-code files are retained in [`docs/adr/stage8-raw/windows`](adr/stage8-raw/windows).  The native Linux originals remain under `/tmp/dshpack-stage8-linux-34718c5a/raw` as part of the retained smoke root described below.

| OS | Starter pack | `dsh` | Commands and exit codes | Key assertions |
| --- | --- | --- | --- | --- |
| Windows | `web-dev` | `0.1.0-rc.6` | `install --yes -- <web-dev>` → 0; `dsh --profile web-dev --dump-config` → 0; `doctor --profile web-dev --strict --yes` → 0 | Dump contains `id: mcp-context7`, `@deepseek-ai/dsh-mcp-client`, `serverName: context7`, `transport: streamable-http`, and `https://mcp.context7.com/mcp`; four web skills exist. |
| Windows | `research-writing` | `0.1.0-rc.6` | `install --yes -- <research-writing>` → 0; `dsh --profile research-writing --dump-config` → 0; `dsh --profile research-writing --dump-default-config` → 0; `doctor --profile research-writing --strict --yes` → 0 | The two dump byte streams are equal; Context7 identifiers are absent; five research skills exist. |
| WSL2 Ubuntu 24.04 (native `/tmp` filesystem) | `web-dev` | `0.1.0-rc.6` | `install --yes -- /tmp/.../packs/web-dev` → 0; `dsh --profile web-dev --dump-config` → 0; `doctor --profile web-dev --strict --yes` → 0 | Same five Context7 dump lines as Windows; four web skills exist. |
| WSL2 Ubuntu 24.04 (native `/tmp` filesystem) | `research-writing` | `0.1.0-rc.6` | `install --yes -- /tmp/.../packs/research-writing` → 0; both profile dumps → 0; `doctor --profile research-writing --strict --yes` → 0 | Profile and default dump are byte-equal; Context7 is absent; five research skills exist. |

Both starter repositories contain a committed deterministic `pack.lock.yml`:

- `web-dev`: `3414f1a chore: add deterministic pack lock`
- `research-writing`: `9ee2853 chore: add deterministic pack lock`

Each was generated twice with byte-identical SHA-512 output and then passed `dshpack validate --strict` with exit 0.

## Linux user-space tools

The WSL smoke root is `/tmp/dshpack-stage8-linux-34718c5a` (a native Linux filesystem, never `/mnt/c`).  It contains the official `node-v22.19.0-linux-x64` tarball installation, `@deepseek-ai/dsh@0.1.0-rc.6` under `tools`, and `pnpm@11.7.0` under `pnpm-tools`.  The Node tarball SHA-256 check reported `node-v22.19.0-linux-x64.tar.xz: OK` and `node --version` reported `v22.19.0`.

To remove every Linux smoke artifact and user-space tool, run:

```bash
rm -rf /tmp/dshpack-stage8-linux-34718c5a
```

This removal command is intentionally documented but was not run, so the captured smoke evidence remains available.

## Certification caveat

During every successful `dsh` subprocess invocation, the current implementation writes command logs below the isolated home at `.dshpack/logs`.  This is relevant because the authoritative plan has conflicting statements about whether `doctor` may write dshpack-owned files; see the delivery report for the exact conflict.
