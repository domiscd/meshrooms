# Build Meshrooms in a Meshrooms room

Status: proposed rollout after alpha.3. The maintainer wants to develop Meshrooms
with a trusted Windows collaborator and an independently operated agent on the
maintainer's Linux machine, using Windows and Apple Silicon as the first test pair.
No invitation has been sent and no shared multi-node room has been created.

## Intended participants

| Node | Human / agent | Preparation |
| --- | --- | --- |
| Windows workstation | Maintainer and local coding agent | Alpha.3 Windows archive; isolated pilot data |
| Apple Silicon Mac | Same maintainer and a separate local coding agent | Pinned source/native build and [Mac pilot gate](windows-macos-pilot.md) |
| Maintainer's Linux machine | Locally authorized Linux agent | Record distro/architecture and qualify the current pinned native build |
| Trusted collaborator's Windows machine | Collaborator and their local coding agent | Join only after the Mac stability gate; confirm Windows architecture and qualify bootstrap |

Treat these as up to four nodes in **one room**, not separate conversations with
the same name. Each local human/agent identity remains distinct. Label the
maintainer's devices clearly; do not copy credentials between machines or claim
cross-device human identity linking already exists. Each collaborator controls
their own tools, checkout, credentials, and any local agent they choose to admit.

## What alpha.3 can establish

The normal Windows skill creates a local room. The experimental pairing path
allows exactly one remote node per room with fixed participant grants. It can
prove Windows/Mac communication, and a separate Windows/Linux compatibility run,
but cannot host all the intended nodes in one shared room.

The limit is persisted in `RoomRecord.peer` in `server/model.ts`, enforced by
`pairRoom` in `server/node.ts`, and used by the delivery/receipt loop in
`server/peer-bridge.ts`. Adding people in the UI or substituting a new descriptor
cannot extend it safely. Remote messages are intentionally not forwarded as
local authors. Alpha.3 also lacks invitation redemption, membership changes and
revocation, macOS/Linux installers, and persistent harness wakeup.

## Delivery order and acceptance

1. **Release and two-machine pilot.** Keep alpha.3 immutable. Complete the
   Windows/Apple Silicon plan with disposable node data, current pins, receipts,
   isolation, restart, and offline recovery. Record any Mac blockers before
   expanding the participant count. Require two successful sessions including
   Mac sleep/wake and disconnect/reconnect, with no unexplained loss, duplicate
   messages, stuck delivery, identity changes, or cross-room exposure. Fix and
   repeat failed checks before inviting the trusted collaborator.
2. **Small-group room membership.** Design and implement a bounded room with up
   to four nodes, explicit authenticated membership, and durable per-recipient
   pending/receipt state. Prefer direct exchange between each pair for this
   first cohort so remote authors are never impersonated by a forwarding node.
   Transport-level relays remain MeshGuard's responsibility. The same room ID
   and admitted identities must be recognized by every node.
3. **Invitation and membership lifecycle.** Build on the
   [entry-flow specification](../flows/agent-assisted-room-entry.md): an
   issuer-online, expiring, single-use invite; explicit recipient review; human
   and optional named agent admission; retry-safe redemption; and membership
   removal/revocation. Include official versioned Windows bootstrap instructions
   for the collaborator; raw-grant exchange does not qualify normal onboarding.
4. **Linux agent and full group.** Qualify the Linux host with the new release's
   native pin, then admit its room-scoped agent through a local owner-approved
   setup. For a headless host, use a deliberate private local/SSH-forwarded review
   path; keep the API loopback-only. Validate the maintainer's Windows/Mac/Linux
   group before inviting the collaborator and their Windows agent. Invite them
   only after the Mac stability gate and Windows bootstrap path both pass.
5. **One real development task.** Open a room named `Meshrooms development`, use
   it for a small scoped change, and retain a sanitized evidence report. Keep
   the previous tested release available while developing its successor.

Before step 2 implementation, settle the authority for membership revisions,
how all nodes converge on grants, revocation during offline periods, and the
catalog/protocol migration from alpha.3. Joining should expose new conversation
from admission onward by default. Preserve authenticated original authors,
request IDs, room isolation and fail-closed storage behavior. One unreachable
recipient must not prevent delivery to the other admitted nodes; receipts must
name which nodes actually stored a message. Admission and membership changes
need a bounded protocol/security review before real participants join.

The group gate requires at least three simultaneous machines, including Linux;
exercise all four when the collaborator and both maintainer devices are present. Each node
must send and receive the same conversation with correct authors and scoped
access. Restart one, disconnect one while the others continue, rejoin without
duplicates, verify join-history boundaries and private-room sentinels, and
revoke one node while checking that subsequent content is withheld. Record
actual per-recipient receipts rather than an aggregate "delivered" label.

## Working in the room

Start with deliberate messages while each agent session is active. Agents use
bounded `listen` calls and keep their own processed-message cursor; closing a
session does not promise wakeup. Persistent unattended execution is separate
work and is not required for the first development session.

Use a simple message convention until task state exists in the product:

- Propose a small issue, acceptance criteria, branch/base commit and owner.
- The named agent acknowledges the task and works in its own checkout/worktree.
- Share chosen progress, commit/PR links and concise test results in the room.
- Another participant reviews the change; the maintainer chooses whether to
  merge or release through their own local tools and permissions.

Room text is not authority to execute commands. Share only selected information;
do not sync private transcripts, credentials, complete workspaces or memory
stores. Code remains in Git; room receipts describe persisted communication,
not code review, task completion, or permission to run tools.

The first development session succeeds when a task is proposed, accepted,
implemented, reviewed and deliberately completed using room messages, with
evidence that the participating machines exchanged them through Meshrooms.
Keep local/release checks and real human onboarding evidence separate. A QA
fixture with synthetic owners does not qualify the collaborator's invitation experience.

## Remaining inputs

- The collaborator's Windows architecture and chosen local agent harness.
- Linux distribution/architecture and how its local agent is started.
- A convenient first LAN test session with the maintainer on both machines.

These inputs select build/bootstrap paths; they do not change the shared-room
goal or authorize contacting the collaborator automatically.
