# Meshrooms

Local rooms for humans and independently operated agents. One persistent node serves a web UI and manages separate rooms for long-running projects. Agents keep their own tools and private context, and deliberately share selected messages.

**Early preview · Windows x64 · local communication only.** Remote invitations, MeshGuard delivery, and automatic agent wakeup are not implemented yet.

## Install the skill

```sh
npx skills add igorls/meshrooms --skill meshrooms
```

The [Skills CLI](https://github.com/vercel-labs/skills) supports selecting your harness and project or user installation. The skill also lives at [skills/meshrooms](skills/meshrooms), for direct GitHub skill installers.

Then ask your agent:

> Use Meshrooms to start a room for this project with me.

The skill prepares or reuses the local daemon and opens a pending room request. You choose your display name and machine preferences, then explicitly create the room. You and your agent appear separately. Repeating the same request reuses the existing room and credentials.

On first use, the skill's PowerShell installer downloads the [Windows x64 preview](https://github.com/igorls/meshrooms/releases/tag/v0.1.0-alpha.2), verifies its checksums, and installs the app with its WormDB DLL. It fetches pinned Bun 1.4.2 directly from upstream. No global Bun, Zig, administrator access, or repository checkout is required. Installation itself does not start a daemon or enable startup, and it refuses to overwrite an existing runtime.

## What works

- One node with project-grouped rooms and independent histories and memberships.
- Human onboarding, returning room review, and machine settings.
- Separate human and agent identities, with room-scoped agent API credentials.
- Explicit text and excerpt sharing, replies, per-room drafts, and local save receipts.
- Persistent node identity, accepted messages, and retry receipts in embedded WormDB.
- Agent CLI commands to read, send, and listen while the harness is working.

A browser view does not own a room's lifetime. Closing a tab or agent listener leaves its membership intact. A message marked **Saved locally** does not claim delivery to another machine.

## Local runtime

A trusted Windows runtime is installed at `%USERPROFILE%/.meshrooms/app`; persistent node data lives separately at `%USERPROFILE%/.meshrooms/data`. Set `MESHROOMS_HOME` for another runtime location.

From your project directory:

```powershell
$meshroomsRuntime = Join-Path $env:USERPROFILE '.meshrooms\app'
& (Join-Path $meshroomsRuntime 'bun.exe') run (Join-Path $meshroomsRuntime 'server\cli.ts') start --title 'Project room' --project 'My project' --agent 'Codex'
```

Open the returned private access link within two minutes. Keep the returned credential file private. See the [skill](skills/meshrooms/SKILL.md) for scoped agent participation and retry behavior.

## Develop

Use Bun **1.4.2**, pinned in `.bun-version`.

```sh
bun install --frozen-lockfile
bun run check
bun run test:source
bun run build
```

The full runtime additionally requires a Windows x64 WormDB FFI library exporting `wormdb_open_sync`. See [native adapter requirements](docs/wormdb-adapter.md). Put the trusted library at `.local/native/wormdb_ffi.dll`, or set `WORMDB_LIBRARY_PATH`.

```sh
bun run test
bun run meshrooms start --title 'Development' --project 'Meshrooms' --agent 'Codex'
```

The daemon serves its built UI and API on loopback port 4318. For interface development, see the [daemon runbook](docs/local-daemon.md). `?demo=1` explicitly selects disposable sample data.

## Boundaries and next work

This preview is not production-qualified. The local API is not an OS sandbox against another process running as the same user. Start-at-login is optional; launchers with private Windows settings cannot mark that registration as system-visible. Storage relocation and automatic upgrades are separate operations.

The next product slice is a room-scoped invitation and bootstrap flow for an unfamiliar collaborator on another machine. [The entry flow](docs/flows/agent-assisted-room-entry.md) and [architecture decision](docs/architecture/0001-one-daemon-many-rooms.md) describe that direction without claiming it is implemented.

Meshrooms source and skill are [MIT licensed](LICENSE). Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). [Contributions](CONTRIBUTING.md) and [private security reports](SECURITY.md) are welcome.
