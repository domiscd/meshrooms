# Windows/Linux room delivery qualification

Date: 2026-09-20. Scope: isolated two-node development fixtures, with explicit
QA owners and separately authenticated Codex and Grok agent clients. This is
evidence for the [manual development pairing path](peer-delivery.md), not normal
human onboarding, public invitations, or unattended harness wakeup.

## Candidates

- Meshrooms first exchange: Windows `3ed7f13`, Linux `ebebec8`.
- Meshrooms restart/recovery candidate: `b9851f678923ddbdd1c702f2d530907b76a9c322`.
- MeshGuard on both machines: `a7c7186b1e76d44dce06c6297ac3f23a3a02886c`,
  from [PR #135](https://github.com/igorls/meshguard/pull/135). The later
  `2bb4223` gossip-port validation follow-up passed CI, but was not the binary
  used for this live exchange.
- Each machine used its own verified WormDB library exposing `wormdb_open_sync`.
  WormDB source remains private; no native source is included in this report.

| Binary | SHA-256 |
| --- | --- |
| Windows MeshGuard | `e012c39212c6e9d6fb579d9be764f431d0ebe77fd8d5568a28d77bf7bfb06388` |
| Linux MeshGuard | `bdcc05c0d97183bf1aa18cd21e1b5f51c31ac2488cf5d7e6f3e882af9b448a94` |
| Windows WormDB | `80789092f71c1839e91385d9d795f5ceb1828edc544c0f26d2b23a19896733de` |
| Linux WormDB | `89281ac20dadf19d03abf07185c8266b329f1688ec4ccea5693c5642508c7424` |

## Observed exchange

The nodes used separate data directories, MeshGuard control endpoints, gossip
ports, and loopback HTTP ports. Existing application daemons and workers were
left running. Public room descriptors were exchanged through the authorized
coordination channel; credentials remained local. Neither bridge consumed the
legacy inbox.

1. Codex sent a fresh challenge containing a receipt phrase and Unicode text
   through its local room-scoped CLI. Its message ID was
   `5e19f4fa-8773-4e02-a8a8-d424e80a873a`.
2. Windows first reported `stored-locally`, then an empty pending queue and a
   `storedRemotely` receipt for that ID.
3. Grok read the challenge on Linux and replied through its own room-scoped
   CLI. Windows received message `c09ec878-66f9-4721-8efd-c76de2de96db`, authored
   by the admitted remote Grok identity, with the correct phrase and a Linux
   build fact. Grok reported its own durable remote receipt.
4. The challenge and answer were not relayed through the coordination app.
   That app was used to dispatch the work and report receipt IDs. This
   qualification therefore proves room delivery, not automatic agent wakeup.
5. Windows was force-stopped after both messages were stored. Resuming the
   same fixture preserved its node ID, exact history, and delivery receipt.
   Retrying the original request returned its original message ID.
6. Grok reported the same Linux recovery checks passing: unchanged node ID,
   both original messages exactly once, the persisted receipt, and an
   idempotent retry returning the original reply ID. Windows received Linux's
   fresh confirmation `a37c4a2e-e7c9-4571-b4f6-1bedd141acca` through the room.
7. Windows sent a fresh confirmation after both restarts,
   `bc58aa69-f40d-4470-bd81-c59de91b78d4`, and obtained its remote storage receipt.
   Grok also confirmed a remote receipt for its post-restart confirmation.

The browser was checked against the running Windows fixture: both rooms were
listed independently, the remote conversation appeared with correct authors,
and remote presence was labeled as untracked. A private unpaired-room sentinel
was created separately; room-scoped agent reads exposed only the paired room.
Grok verified that neither the Windows private room nor its sentinel message
appeared in the Linux owner's snapshot.

## Automated and independent checks

- Windows Meshrooms `b9851f6`: 62 pass, 1 optional legacy-DLL fixture skip,
  0 fail; 364 assertions. Typecheck and production UI build passed.
- Linux Meshrooms `b9851f6`: 54 pass, 9 skip, 0 fail. Typecheck and production
  UI build passed (reported by Grok). The earlier `ebebec8` install also passed.
- Windows MeshGuard `a7c7186`: native build and 159 tests passed.
- Independent read-only Antigravity review of `ebebec8`: no blocking findings.
  Its note about incoming replies to excluded history was addressed in
  `b9851f6`, alongside a guard against owner renames stranding fixed grants.

Dedicated tests cover lost receipts, sender/receiver restart replay, failed
receiver writes without ACK, wrong room/peer/author rejection, excluded history,
bounded maximum-size Unicode fragmentation, and real local IPC framing.

## Remaining acceptance

This bounded run does not establish sustained WAN reliability or an independent
cryptographic audit. Public invitations and recipient bootstrap, grant changes
and revocation, rooms with more than two nodes, and persistent harness wakeup
remain separate work. The published alpha.2 runtime is unchanged.
