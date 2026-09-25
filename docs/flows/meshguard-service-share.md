# MeshGuard service share for native rooms

Status: first Meshrooms slice in progress. MeshGuard hot-reload of service
policies is a follow-up in the MeshGuard repo.

Date: 2026-09-25

## Goal

An operator on a native Meshrooms node can share **one** localhost TCP port with
the paired peer so the other machine can open a frontend preview (prefer
`vite preview` or a static build). Sharing stays **outside** the browser site.
The room shows who is sharing, which port, and how to reach it, with an explicit
stop and an expiry.

This is the native half of the port-share discussion. Browser-room TCP-over-data-channel
forwarding is a separate task.

## What MeshGuard already provides

MeshGuard filters **inbound** mesh traffic at decrypt→TUN with identity-aware
port policies (`meshguard service`):

- Per-peer allow/deny for `tcp`/`udp` ports
- Evaluation order: peer → org → global → default
- Policies live under `$MESHGUARD_CONFIG_DIR/services/`
- Peers and mesh IPs are available over the control socket (`PEERS`, `STATUS`)

With a default-deny posture and `allow --peer <paired> tcp <port>`, only that
peer can reach the shared port on this node's mesh IP.

## Current MeshGuard limits (honest)

1. **Policies load at daemon startup.** Applying a new allow today requires
   rewriting the policy file and **restarting MeshGuard**. Live share/stop
   without restart needs a MeshGuard control command that updates the in-memory
   filter (follow-up).
2. The Meshrooms control adapter today speaks `STATUS`, `APPINFO`, `APPSEND`,
   `APPRECV`, and `XFER*`. It does not yet manage service policies.
3. The preview process must **listen on the mesh IP** (or `0.0.0.0`). Binding
   only to `127.0.0.1` is unreachable over WireGuard even when the policy allows
   the port.
4. Prefer `vite preview` / static builds. Raw Vite dev servers expose `/@fs/` and
   similar paths; a share is filesystem access unless the operator accepts that.

## Product rules

| Rule | Detail |
| --- | --- |
| Operator approval | Only the local human/operator starts or stops a share. Agents may prepare a preview process; they do not open MeshGuard policy without an explicit operator command. |
| One port | At most one active share per node (first slice). |
| One peer | Allow only the room's paired MeshGuard peer key. |
| Visible | Room members see sharer, port, mesh URL, started-at, expires-at. |
| Expiry | Default 30 minutes; stop clears the policy intent immediately. |
| Outside the site | No preview origin on `meshrooms.wormdb.dev`. Recipients open `http://<mesh-ip>:<port>/` on their own machine. |
| Default posture | Document that production-like nodes should run `meshguard service default deny` before relying on per-peer allows. |

## Meshrooms first slice

Ship design + local orchestration in Meshrooms without waiting for MeshGuard
hot-reload:

1. **Share record** on the local node for a paired room: port, peer key, mesh IP,
   started/expiry, status (`active` \| `pending-meshguard-restart` \| `stopped`).
2. **CLI** (operator-facing):
   - `meshrooms share --room <id> --port <n> [--minutes 30]`
   - `meshrooms share-stop --room <id>`
   - `meshrooms share-status --room <id>`
3. **Policy write:** append/replace the per-peer allow for that TCP port under the
   configured MeshGuard config dir (or invoke `meshguard service allow --peer …`),
   then set status to `pending-meshguard-restart` until the operator restarts
   MeshGuard (or until a future hot-reload command succeeds).
4. **Announce** the share to the paired room over the existing MeshGuard
   application channel (structured share event, not a chat impersonation). The
   other node shows it in transport/share status; a short human-visible notice
   can mirror it once.
5. **Stop** removes the allow intent and announces stop. Until hot-reload exists,
   stop also remains `pending-meshguard-restart` until MeshGuard reloads.

Do not claim the port is reachable while status is pending restart.

## Recipient flow

1. See the share in room/transport status: `http://10.x.x.x:4173/`.
2. Open it in a local browser on the recipient machine (mesh routing already up).
3. When the share stops or expires, the URL should fail closed.

## Follow-ups (not this slice)

- MeshGuard: control-socket `SERVICEALLOW` / `SERVICEDENY` / `SERVICERELOAD` so
  share/stop does not restart the daemon.
- Binding helper: optional wrapper that runs `vite preview --host <mesh-ip>`.
- Multi-port or multi-peer shares.
- Browser-room agent-to-agent TCP tunnel (separate design).

## Acceptance for this slice

1. On a paired Linux/Windows (or Linux/Linux) fixture, an operator can record a
   share for one TCP port aimed at the paired peer key.
2. After MeshGuard restart with the new policy, the peer can fetch the preview
   over the mesh IP; an unpaired peer cannot.
3. Stop/expiry clear the local share record and announce stop; after reload, the
   port is denied again under default-deny.
4. Docs state the restart limitation and the `vite preview` recommendation.
5. No change to the browser site origin or to browser-room signaling.
