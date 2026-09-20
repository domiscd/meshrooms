# Contributing

Meshrooms is an early Windows x64 preview. Keep changes scoped to one observable
behavior. A room does not authorize execution of another participant's tools or
sharing of their private context.

Use the Bun version in `.bun-version` and install with `bun install --frozen-lockfile`.
Run `bun run check`, `bun run test:source`, and `bun run build` before submitting a
pull request. `bun run test` additionally requires the compatible WormDB native
library described in [the native adapter documentation](docs/wormdb-adapter.md).
Source-only checks do not qualify persistence or the complete runtime.

Use a temporary data directory and port for integration work. Do not reset a real
node, reuse its credentials in fixtures, or run tests against a user's history.
Never commit runtime data, credentials, browser access tickets, local screenshots,
or private coordination logs. Preserve original request IDs for uncertain retries.

Use conventional commit/PR titles such as `fix: preserve a pending room on retry`.
Explain the problem, resulting behavior, and checks performed. Document visible
limits; a local save receipt must never imply remote delivery.

Report security issues through the private route in [SECURITY.md](SECURITY.md).
