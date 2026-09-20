# Meshrooms

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React and TypeScript with Vite for the UI build. One Bun daemon serves the local API and built UI, with WormDB embedded through its native C ABI. Vite also retains an explicitly selected in-memory demo. No native shell wrapper.

## Users

Developers, their independently operated agents, and collaborators working across several long-running projects and rooms. Rooms may share some, all, or none of their participants. Each participant retains their own tools, checkout, credentials and private context.

## Product Purpose

Help humans and agents discuss work and deliberately share selected messages or excerpts. Layout A is selected. The current local slice preserves room identity and accepted conversations across daemon restarts while keeping each room's unpublished browser work separate.

## Operating Context

One persistent Meshrooms daemon per machine manages independent rooms and serves the local web UI. Room lifetime does not depend on a selected tab or open browser. The local node uses room-scoped WormDB history, one human owner, and separately authenticated local agent clients. A shared MeshGuard attachment is subsequent integration work.

## Intended Entry Flow

A human already working with an agent invokes the Meshrooms skill to prepare the machine and start a project room. The first browser visit provides short onboarding and daemon settings; explicit acceptance creates separate human and agent members. Returning users reuse their daemon and settings. This creator flow is implemented for the Windows local runtime. The next slice lets a human generate an invitation and an unfamiliar recipient hand its bootstrap prompt to their own agent. See [the entry-flow specification](docs/flows/agent-assisted-room-entry.md).

## Capabilities and Constraints

Local slice: project-grouped rooms, independent histories and membership records, per-room drafts/replies/share previews, explicit sending, local receipts, stable node identity, persistent command deduplication, and one-writer ownership. A room switch changes only the view. Human browser sessions use a private cookie; agent credentials constrain API access to their admitted room. The daemon is loopback-only and never executes received content. Windows startup registration is applied only after an explicit settings choice. It has no MeshGuard bridge, remote admission/delivery receipts, E2EE qualification, or durable remote outbox. The explicit demo uses labeled sample people/history and remains memory-only.

## Brand Commitments

Meshrooms is provisional. Concise operational copy; no marketing claims, dashboard metrics or decorative feature cards. Layout A's navy navigation rail and light conversation surface are selected; comparison variants are retired. `/prototype/room` remains the prototype entry point.

## Evidence on Hand

The architecture decision records the separate application and one-daemon model. Local recovery and browser evidence is tracked in NOTES.md. Native library provenance and durability limits are in docs/wormdb-adapter.md. MeshGuard transport qualification proceeds independently; this UI is not yet connected to it. Synthetic content appears only in explicit demo mode.

## Product Principles

- Sharing is explicit and reviewable.
- A room does not grant authority over another participant's tools.
- State labels describe the evidence available.
- Transport and persistence remain replaceable seams.
- One machine daemon owns many room lifecycles; a browser view does not own a room.
- Membership, history, publication, and synchronization are scoped by stable room ID.
- Project grouping organizes rooms locally and does not grant access to them.

## Open Decisions

Name, remote invitation authority, agent wakeup adapters, transport authentication, scalable append history, and remote outbox/recovery remain open. Layout A, the one-daemon/many-rooms model, local agent credentials, and local WormDB persistence are implemented; see `docs/architecture/0001-one-daemon-many-rooms.md` and `docs/local-daemon.md`.
