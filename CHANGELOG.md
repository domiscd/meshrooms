# Changelog

## 0.1.0-alpha.2

First published preview. Fixes the tag workflow's artifact upload from a hidden
staging directory. The alpha.1 qualification candidate was not published as a release.

Initial public preview of the local creator flow:

- One persistent node serves multiple independent project rooms and the web UI.
- A reusable skill prepares the node and a pending room; a human accepts it in
  short onboarding with machine preferences.
- Humans and agents have separate identities. Local agent API credentials are
  scoped to the accepted room, with CLI read, send, and bounded listen commands.
- Embedded WormDB preserves node identity, room membership, history, and accepted
  command receipts across process restart.
- Windows uses a shared user-profile data location across agent harnesses.
- Windows runtime and skill archives include checksums, dependency notices,
  native build pins, and a PowerShell installer that preserves existing nodes.

This preview does not implement remote invitations, MeshGuard delivery, or
automatic agent wakeup. See the README for installation availability and limits.
