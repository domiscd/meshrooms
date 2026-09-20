# Portable Runtime Packaging

Meshrooms provides a packaging script (`scripts/package-runtime.ts`) for the local daemon, native DLL, and built UI on Windows x64. Local bundles include Bun by default. Public releases use `--external-bun`: the skill installer downloads pinned Bun directly from upstream, verifies it, and adds it to the installed directory.

The packaged output allows a user or automated agent to run Meshrooms without Bun installed globally, without repository checkouts, and without downloading `node_modules`.

## Bundle Layout

The resulting package contains:

```
<outputDir>/
├── bun.exe                         # Added by installer; omitted from public app ZIP
├── package.json                    # Minimal module definition {"type": "module"}
├── manifest.json                   # Unsigned integrity manifest with SHA-256 for each bundled file
├── dist/                           # Built web UI assets (dist/index.html, assets/...)
├── server/                         # Production TypeScript server files
│   ├── cli.ts                      # CLI entrypoint (status | ensure | start)
│   ├── daemon.ts                   # Local daemon runner
│   ├── runtime.ts                  # Discovery, HMAC proofs, and lifecycle
│   ├── instance.ts                 # Mutex lock ownership
│   ├── http.ts                     # Loopback HTTP and SSE server
│   ├── node.ts                     # Local node catalog and history
│   └── persistence/                # WormDB persistence adapter
│       ├── store.ts
│       └── wormdb.ts
├── src/                            # Shared type definitions for server imports
│   ├── room.ts
│   └── setup.ts
├── skills/meshrooms/               # Skill, installer, and license
├── LICENSES/                       # Dependency notices, including WormDB binary license
└── .local/
    └── native/
        └── wormdb_ffi.dll          # 64-bit WormDB native library with wormdb_open_sync
```

## Manifest (`manifest.json`)

Every package includes a Schema 1 integrity manifest:
```json
{
  "schema": 1,
  "platform": "win32",
  "arch": "x64",
  "version": "0.1.0-alpha.1",
  "bun": { "version": "1.4.2", "bundled": false },
  "git": {
    "commit": "7a1d7c64fdc30b542a8c35ec07db50031725910d",
    "dirty": false,
    "releaseCommit": "7a1d7c64fdc30b542a8c35ec07db50031725910d"
  },
  "entry": "bun.exe run server/cli.ts",
  "files": {
    ".local/native/wormdb_ffi.dll": "sha256...",
    "dist/index.html": "sha256...",
    "server/daemon.ts": "sha256...",
    ...
  }
}
```
- **Source pin:** If uncommitted changes exist in the source repository (`dirty: true`), `releaseCommit` is null. A clean source pin identifies a checkout; it does not certify an official release.
- **Integrity:** Every file entry records its exact byte SHA-256 hash.

This unsigned manifest detects changes relative to a trusted copy. It does not
authenticate a publisher or replace signed distribution. The native DLL is the
separately pinned synchronous WormDB candidate documented in `wormdb-adapter.md`.

## Invariants & Safety

1. **No Overwrite / No Deletion:** Packaging fails closed immediately if `outputDir` already exists. It never recursively deletes or modifies existing directories.
2. **Strict Exclusions:** Sensitive files (`control.key`, `runtime.json`), user data directories, log files (`*.log`), development dependencies (`node_modules`), and tests (`*.test.ts`, `test-directory.ts`, `mockRoom.ts`) are excluded.
3. **Execution Seam:** Commands run directly via `./bun.exe run server/cli.ts`. Daemon defaults for relative paths (`.local/native/wormdb_ffi.dll`, `dist/`) resolve naturally within the bundle.

## Usage

```powershell
# Default: packages current repo to .local/packages/current
bun run scripts/package-runtime.ts

# Explicit paths
bun run scripts/package-runtime.ts --out .local/packages/candidate

# Run a trusted bundle from any project directory, using its absolute path.
$meshroomsRuntime = Join-Path $env:USERPROFILE '.meshrooms\app'
& (Join-Path $meshroomsRuntime 'bun.exe') run (Join-Path $meshroomsRuntime 'server\cli.ts') start --title 'Project room' --project 'My project' --agent 'Codex'
```

Install using the skill's `scripts/install.ps1` into a new runtime directory, normally
`%USERPROFILE%/.meshrooms/app`. The data directory remains separately at
`%USERPROFILE%/.meshrooms/data`. AppData can be private to the launching packaged
harness, so it is unsuitable for this shared node default. Never copy an existing user's data, `control.key`,
runtime marker, or agent credentials into a distributable package. Copy the
bundled `skills/meshrooms` into the chosen harness's skill directory if needed.
Set `MESHROOMS_HOME` when using another runtime location. Upgrading a running
daemon and changing a registered startup path need an explicit lifecycle step;
the packager itself neither stops daemons nor overwrites existing output.

This packaging slice is Windows x64 only. Signed releases, an automatic updater,
other-platform bundles, and remote recipient bootstrap are not implemented.
The public release procedure is described in [releasing.md](releasing.md).
Built UI inputs are restricted to the expected index and assets;
unexpected files or symbolic links fail packaging instead of entering the bundle.
