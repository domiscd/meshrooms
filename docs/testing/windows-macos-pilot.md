# Windows / Apple Silicon maintainer pilot

Status: planned, not executed. Target: `v0.1.0-alpha.3` on both machines.
One maintainer operates Windows and an Apple Silicon Mac, with a separate local
agent on each. First prove local Mac persistence, then deliberate two-way room
delivery on the same LAN. Test different networks only after the LAN pass.

This is development qualification with labeled QA owners. It does not qualify
public invitations, normal recipient onboarding, a macOS installer, or automatic
agent wakeup. Windows release installation is a separate check from peer setup.

## Pins and prerequisites

| Input | Pin / requirement |
| --- | --- |
| Meshrooms | `v0.1.0-alpha.3`; record its resolved commit on both hosts |
| Bun | `1.4.2`, native `arm64` on the Mac (no Rosetta) |
| Zig | `0.16.0` |
| WormDB | `f96b1aa794904585aaacd9a3c83ff688a031f743` |
| WormDB embedded MeshGuard submodule | `fdbfd51bdbc643bae0aff8cb7b11e9372f6a23a8` |
| Separate MeshGuard transport | `a0fa2f3b37550e2aa0615a5479d7791319a0d044` (merged PR #135); qualify on both hosts |
| Transport protocol | `APPINFO` protocol 1; `APPSEND` / `APPRECV`, channel `meshrooms-v1` |

The embedded MeshGuard submodule is a WormDB build dependency; it is not the
separate transport daemon. Do not use that older submodule as the transport.
The prior [Windows/Linux evidence](../peer-delivery-qualification.md) used an
earlier transport candidate and does not qualify these pins on macOS.

Record macOS version, `uname -m` (`arm64`), Bun/Zig versions, source commits,
native binary hashes, and test results. The Windows DLL must match the release
lockfile. A locally built Mac dylib has its own hash; the Windows hash cannot
validate it. Keep dependencies in new checkouts, away from working projects.

## 1. Mac preparation and local gate

With Git, native Bun 1.4.2, Zig 0.16.0 and Apple command line build tools available,
run in a new empty pilot directory. Stop on any failing command:

```sh
git clone --branch v0.1.0-alpha.3 --single-branch https://github.com/igorls/meshrooms.git
git clone --no-checkout https://github.com/igorls/wormdb.git
git -C wormdb checkout --detach f96b1aa794904585aaacd9a3c83ff688a031f743
git -C wormdb submodule update --init deps/meshguard
git -C wormdb/deps/meshguard rev-parse HEAD
# Verify the submodule pin in the table before building.
(cd wormdb && zig build ffi -Doptimize=ReleaseFast -Dcrypto-backend=std)
file wormdb/zig-out/lib/libwormdb_ffi.dylib
nm -gU wormdb/zig-out/lib/libwormdb_ffi.dylib | grep wormdb_open_sync
shasum -a 256 wormdb/zig-out/lib/libwormdb_ffi.dylib
export WORMDB_LIBRARY_PATH="$PWD/wormdb/zig-out/lib/libwormdb_ffi.dylib"
cd meshrooms
bun install --frozen-lockfile
bun run check
bun run test:source
bun run test
bun run build
```

Require the dylib to be arm64 and export `wormdb_open_sync`. Record skips
explicitly: Windows packaging/startup tests are not Mac qualification, and the
optional legacy-library fixture may be absent. Native persistence, instance
locking, actual daemon receipts and forced-restart recovery must execute and pass.
If anything fails, retain the exact error and stop before pairing.

## 2. Isolated transport and room fixtures

Build the separate transport from the pinned commit in a new checkout on each
host (`zig build -Doptimize=ReleaseFast -Dno-sodium=true`, then its native tests).
Inspect that pin's CLI help. Use fresh `MESHGUARD_CONFIG_DIR` identities, unique
`MESHGUARD_CONTROL_PATH` endpoints, and unused explicit `--gossip-port` values.
On macOS keep the Unix socket path short and inside a private directory.

Generate each test identity with `keygen`; exchange only the exported public
keys and mutually `trust` those keys. Run `up --gossip-only --gossip-port PORT
--seed PEER_LAN_IP:PEER_PORT`. Keep trust enforcement enabled. Confirm peer
reachability, the local public key from `STATUS`, and protocol 1 from `APPINFO`.
Use the hex STATUS key for Meshrooms attachment, not the base64 export text.
Permit only the test UDP port if the OS prompts; the HTTP API stays loopback.
Do not run `meshguard agent`, consume the legacy inbox, or repurpose live daemons.

Use the tagged Meshrooms source checkout on each host: the release ZIP does not
include `scripts/qualify-peer-node.ts`. On Windows set `WORMDB_LIBRARY_PATH` to
the alpha.3 archive's verified DLL, leaving the installed alpha.2 library alone.

Generate one shared room UUID. In each checkout, run the following with local
values and distinct agent names (for example, `Windows Codex` and `Mac Codex`):

```text
bun run scripts/qualify-peer-node.ts --data-dir EMPTY_PILOT_DATA --room SHARED_UUID --agent LOCAL_AGENT_NAME --peer-key LOCAL_HEX_KEY --socket LOCAL_CONTROL_PATH --port UNUSED_HTTP_PORT
```

The fixture creates a labeled QA owner, its agent, and a private unpaired room.
It prints a public descriptor and a private local credential-file path. Exchange
only the public descriptors through the maintainer, review their room ID, keys,
participant names and roles, and save each peer descriptor as local JSON. Then:

```text
bun run server/cli.ts pair --data-dir PILOT_DATA --descriptor PEER_DESCRIPTOR_JSON
bun run server/cli.ts transport --data-dir PILOT_DATA
bun run server/cli.ts open --data-dir PILOT_DATA
```

Browser links, control keys, credentials, private logs and data stay on their own
host. No production project files are needed. A local browser link is not an
invitation. Retain exact fixture launch arguments and only its process IDs for
restart/cleanup. Resuming requires the same arguments plus `--resume true`.

## 3. Acceptance sequence

Each local agent uses its own credential with CLI `send`, `read`, and bounded
`listen --wait-seconds 30`. Preserve request IDs on retries and the last actually
processed message ID as the listen cursor. Use the [pairing runbook](../peer-delivery.md)
for those commands. The maintainer starts both agent sessions manually.

| Check | Evidence required |
| --- | --- |
| Windows to Mac | Fresh challenge containing Unicode arrives exactly once, with the admitted Windows author; Windows `storedRemotely` contains that message ID |
| Mac to Windows | Mac agent reads through its scoped CLI and replies to the challenge through Meshrooms; Windows reads the exact reply; Mac gets its remote receipt |
| Browser | Both local browsers show matching conversation and distinct human/agent identities; remote presence is not presented as continuously tracked |
| Isolation | Put a unique sentinel in each private unpaired room through its local owner browser; neither sentinel nor private room appears in the other node's owner snapshot or in either paired-room agent read |
| Restart | Stop only one fixture process, resume it, and verify unchanged node ID, original messages exactly once, retained receipts, and original ID returned on identical request retry; repeat on the other host |
| Offline recovery | Stop the receiving fixture, send once, observe pending delivery, resume the receiver, and require one persisted copy plus a remote receipt without changing the request ID |
| After recovery | New challenge/reply succeeds in both directions after both restarts |

For each step record pass/fail, host, timestamp, request/message IDs, pending
counts, and receipt IDs. Do not substitute messages copied through chat for
actual room delivery. A receipt means remote storage, not agent reasoning.
Use a five-minute troubleshooting bound per pending delivery; preserve evidence
and diagnose before changing pins or configuration.

After LAN success, optionally repeat the same sequence across different networks
and record actual reachability/relay conditions. Do not infer WAN reliability
from LAN success or silently open router ports.

Before inviting another tester, complete two successful Windows/Mac sessions,
including Mac sleep/wake and disconnect/reconnect. Require unchanged identity,
eventual receipts, exact-once visible messages and no private-room exposure;
diagnose and repeat any failed checks. The maintainer's Linux agent follows this
gate; the trusted Windows collaborator and their agent join after the internal
group and invitation/bootstrap checks in the [development-room plan](meshrooms-development-room.md).

## 4. Completion and handoff

Save a sanitized result report with exact pins/hashes, macOS gate output, the
acceptance table, failures/skips, and remaining gaps. Stop only the recorded
pilot PIDs and retain isolated data for diagnosis. Do not delete existing
installations, alter startup settings, or replace the maintainer's live node.

Prompt for the Mac's local agent:

> Prepare my Apple Silicon Mac for the Meshrooms v0.1.0-alpha.3 Windows/Mac pilot.
> Read docs/testing/windows-macos-pilot.md at that tag and follow the pinned Mac
> build and local qualification gate in a new directory. Preserve all existing
> daemons and data. Report architecture, versions, commits, dylib hash, and actual
> tests/skips. Then prepare the isolated transport and exchange only its public
> key with me. Coordinate the shared room UUID and descriptors with me before
> pairing. Keep all credentials local. Do not claim the peer test passed until
> challenge/reply, receipts, isolation, restart, and offline recovery pass on both
> machines. I will operate the Windows side and start both local agent sessions.
