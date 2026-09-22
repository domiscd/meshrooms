# Browser rooms preview

This separate runtime implements reusable browser room links, live host admission,
and multiple devices for one human. The hosted entry is
<https://meshrooms.wormdb.dev/rooms>. It is not part of the
published alpha.3 installer. The native MeshGuard /
WormDB node and its existing rooms remain separate.

## Run locally

```sh
bun install --frozen-lockfile
bun run build
bun run browser
```

Open http://127.0.0.1:4320/rooms. Create a room and open its link in a separate
browser profile to test admission. Choose **Use my existing identity** to test a
second device: enter its displayed code under **Room details → Add another device** in the
trusted room session. A host can approve their own device in that action; another
member confirms ownership before the host approves room access.

The loopback HTTP URL is for local development. Another physical device needs an
HTTPS deployment with the configured public origin. A LAN HTTP address does not
satisfy the browser crypto/storage requirements.

| Environment variable | Purpose |
| --- | --- |
| MESHROOMS_BROWSER_PORT | Loopback listener, default 4320. |
| MESHROOMS_BROWSER_ORIGIN | Exact browser origin, default http://127.0.0.1:4320; HTTPS for remote use. |
| MESHROOMS_BROWSER_DATA | Coordinator store directory, default .local/browser-rooms. |
| MESHROOMS_STUN_URLS | Comma-separated STUN URLs; none by default. |
| MESHROOMS_TURN_URLS | Comma-separated TURN URLs; requires a compatible TURN service. |
| MESHROOMS_TURN_SECRET | Shared TURN REST credential secret; never serve this value to browsers. |
| MESHROOMS_TRUST_LOOPBACK_PROXY | Set to 1 only behind a loopback proxy that overwrites X-Real-IP. |
| MESHROOMS_REVISION | Committed revision reported by /api/lobby/health. |

The browser runtime is separate from the domain's static website. Its HTTPS
deployment uses proxy routes for /rooms, /r/:id, /api/lobby, and the Vite assets,
preserved Host/Origin, and a CSP permitting same-origin coordination requests.
Keep the public website's existing assets available. Browser assets and API are
served by this runtime; private admission data must never be in the web root.

## Implemented boundaries

- Non-exportable P-256 private device keys are kept in IndexedDB. Commands prove
  key possession and bind the action, origin, room, request ID, and timestamp.
- Only an authenticated host may admit new members. The link gives lobby access;
  it exposes no member list or connection descriptions before admission.
- Companion devices receive separate device credentials and map to the approving
  human. Display names never link identities. One browser profile keeps one device
  identity; one active tab per room prevents conflicting connection ownership.
- Admission and request receipts persist in a separate SQLite store. Transactions
  deduplicate retried operations. This is coordination metadata, not chat storage.
- Browser messages travel over WebRTC data channels with signed, room-scoped author
  envelopes. The coordinator carries bounded, expiring SDP descriptions, not chat
  messages. It is trusted for membership and signaling in this first slice;
  independent host-signed membership chains are not implemented.
- IndexedDB transactions persist local history and outgoing messages before
  signaling delivery. Receipts mean storage in the receiving browser, not a human
  read receipt or the native WormDB durability guarantee. Browser storage may be
  cleared or evicted; there is no cloud backup or credential recovery yet.
- New members receive only messages sent after their admission. Companion history
  backfill is not implemented yet. Pending delivery targets are fixed when a
  message is sent, so old queued messages cannot leak to later arrivals.
- Peers close connections to removed devices after the next successful membership
  poll. The coordinator rejects removed-device signaling immediately. Revocation
  propagation requires coordination connectivity; this is not an offline revocation
  protocol. A removed device can deliberately request fresh admission.

## Limits and next qualification

This preview caps the service at 64 rooms, 16 devices and 16 pending requests per
room, and 1,000 messages per local browser room. Requests expire after ten minutes.
The HTTP rate limit is 240 API requests per source address per minute locally,
or 1,200 behind the explicitly trusted loopback proxy. Nginx overwrites X-Real-IP;
forwarded headers from direct clients are ignored. Room creation is limited to
six attempts per address per hour and eight hosted rooms per device. Network
quotas are in memory and reset on service restart; the device/global caps persist.
This small preview has no account gate or self-service room deletion. Operators
can retire specific rooms after backup using the [deployment runbook](browser-deployment.md).

Same-machine isolated Chromium profiles prove live admission, Unicode messages
and storage receipts, reload identity/history, companion authorship, removing one
device, decline/cancel, duplicate-tab handling, and desktop/tablet/mobile layout.
The room UI keeps the composer visible while history scrolls. Browser checks also
cover unread-message navigation, drafts and focus when closing Room details, and
Enter to send / Shift+Enter for a new line. This
does not qualify Safari or a real Mac, NAT traversal between networks, or TURN.
No default external ICE server is silently used. Relay credentials can be issued,
but configuring a TURN URL is not evidence of a working relay route.

For broader qualification: exercise real Windows/Apple Silicon browsers over HTTPS,
test sleep recovery, expand public-service abuse controls and room lifecycle UI,
review the admission protocol,
and connect the existing local agent runtime through an explicitly authorized
bridge. Native MeshGuard interoperability, agent attachment/wakeup, room-link
rotation, identity recovery, and companion history synchronization remain work.

## Reproduce checks

```sh
bun test server/browser
bun run check
bun run build
```

For the real browser smoke test, run an isolated coordinator on port 14330 (set
MESHROOMS_BROWSER_PORT and a separate MESHROOMS_BROWSER_DATA), install Playwright
and its Chromium browser, then run:

```sh
node scripts/browser-room-smoke.mjs
```

MESHROOMS_PLAYWRIGHT_MODULE can point to an already installed Playwright package.
MESHROOMS_BROWSER_TEST_ORIGIN selects a different loopback test origin. With a
configured TURN service, MESHROOMS_TEST_FORCE_RELAY=1 forces relay candidates and
asserts the selected route. Evidence and screenshots go under the ignored
.impeccable/review directory. The script defaults to a loopback coordinator.
An intentional hosted smoke test requires MESHROOMS_BROWSER_ALLOW_PRODUCTION=1
and the exact Meshrooms HTTPS origin. MESHROOMS_TEST_TURN_TRANSPORT=udp, tcp, or tls
restricts relay candidates during qualification. Tests create synthetic QA rooms
and report their roomId for cleanup.
