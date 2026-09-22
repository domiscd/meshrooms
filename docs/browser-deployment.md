# Hosted browser preview

The static site and browser runtime share meshrooms.wormdb.dev. The browser
coordinator listens only on 127.0.0.1:4320. Nginx proxies /rooms, /r/, /api/lobby,
and missing static assets to it. The runtime supplies its own content policy;
the static site's connect-src 'none' must not be inherited by these routes.

## Files and service ownership

- /opt/meshrooms/releases/<git-sha>: immutable browser source, built dist,
  static website, deployment files, and release.env with MESHROOMS_REVISION.
- /opt/meshrooms/current: active release symlink.
- /opt/meshrooms/bin/bun: pinned Bun 1.4.2, checked against upstream SHA-256.
- /etc/meshrooms/browser.env: origin, state path, proxy trust, STUN/TURN URLs,
  and the shared TURN secret. Mode 0640, root:meshrooms. Never publish it.
- /var/lib/meshrooms-browser: admission SQLite and OS lock, mode 0700,
  owned by the unprivileged meshrooms service account. No chat history is stored.
- /etc/meshrooms/turnserver.conf: rendered deploy/turnserver.conf.example,
  mode 0640, root:turnserver. A separate meshrooms-turn service owns the relay.

Use deploy/systemd service definitions. The relay listens on the host's public
IPv4 address, accepts short-lived authenticated allocations, bounds bandwidth and
allocation counts, and denies private/special peer networks. Open only 3478
UDP/TCP, 5349 TCP, and 49160–49259 UDP for this service. Existing HTTPS and native
MeshGuard services remain separate. The scoped Certbot hook copies renewed TLS
files into /etc/meshrooms/turn and restarts this relay only.

## Release

Build and test a clean committed revision. Package only server/browser,
server/instance.ts, src/browser/protocol.ts, dist, website, deploy, and release.env.
Hash the archive locally and verify that hash after SSH transfer. Keep admission
data and credentials out of the archive and web roots.

Before activation, start a separate candidate on another loopback port with a
separate data directory and the public origin. Its health endpoint must report
the intended revision, and candidate tests must pass. Save the previous app/site
symlink targets and Nginx configuration. Atomically point the active symlinks at
the new release, restart the browser coordinator, validate Nginx, then reload it.
If health or routing fails, restore previous symlinks/configuration and restart
the previous coordinator. Never roll back by overwriting the admission database.

Verify public HTTPS /rooms, /r/<id>, /api/lobby/health, hashed assets, static site,
404 handling, Host/Origin rejection, and unchanged native service state. Run the
browser smoke with forced relay and inspect selected ICE candidate pairs; merely
configuring a TURN URL is not qualification. Test the TLS relay separately.
The HTTP request-body cap, application quotas and relay quotas all remain active.

## State and recovery

Back up admission with SQLite's online backup API into a root-only backup folder;
copying a live database file without its WAL is not a reliable backup. The
coordinator reconstructs admission after restart. Browsers renegotiate connections
against its new epoch and retain their own message history/outbox.

The preview caps service rooms at 64 and hosted rooms per device at eight. To
retire a room, first confirm its exact UUID and ownership with the operator,
back up admission, stop the coordinator, and delete that UUID only using a
parameterized SQLite DELETE FROM rooms WHERE id = ?. Restart and verify health.
Do not delete rooms by title or age, and do not remove other rooms to make a test
pass. This is an operator lifecycle procedure until room closure has its own UI.

Local and HTTPS origins have separate browser identity/history. Moving a local
room's URL to the public domain does not migrate it. Create a hosted room and use
the companion-device flow there; do not upload local keys or browser storage.

References: [Bun installation](https://bun.sh/docs/installation),
[Coturn configuration](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).
