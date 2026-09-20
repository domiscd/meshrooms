# Releasing

Meshrooms source and skill are public. Windows binaries are prepared locally from reviewed Meshrooms source and an authorized private WormDB checkout. Do not publish that checkout, private patches, credentials, room data, or local development history.

1. Update the package version, skill installer default, changelog, and matching release notes. Keep the Bun version and upstream archive checksum in agreement.
2. Build or verify the native input using [the native build procedure](native-build.md). Retain its license and dependency notices.
3. Run source checks and the complete native suite. Validate the skill with the skill-creator validator when available.
4. Commit a clean reviewed tree. Run `./scripts/package-release.ps1 -OutputDirectory <new-directory> -NativeDirectory <qualified-native-output>`. This rechecks dependencies, build, native tests, and native hash before packaging. The explicit native directory avoids replacing a DLL used by an existing daemon.
5. Test the installer against the produced archive and checksum file in a fresh temporary application directory. Exercise room creation, admission, and agent send/read with isolated node data. Never use a maintainer's live node for this check.
6. Inspect ZIP contents and manifest hashes. The runtime manifest records the exact clean Meshrooms commit. The native lockfile records the library build inputs and hash. The app ZIP deliberately omits Bun; the installer fetches and verifies it directly from upstream.
7. Push only reviewed public history. Confirm GitHub source CI is green, then tag that exact commit `v<version>`. The tag workflow validates source and packages the skill as a CI artifact; it does not publish binaries.
8. Create a draft GitHub prerelease with the two ZIP files, `wormdb.lock.json`, and `SHA256SUMS.txt`. Use the corresponding release-notes file. Download those assets again and compare hashes, then publish the prerelease.
9. Verify unauthenticated repository and release access, a real skill installation into an isolated directory, and the online runtime installer. Do not overwrite the maintainer's installed skill or daemon.

For the first publication, push only the sanitized public main snapshot. Retain old development branches locally. Do not use `git push --all` or mirror a private worktree.

The checksums and manifest are unsigned integrity records. They rely on the official repository and HTTPS distribution channel. Published assets are immutable by convention: a changed build needs a new version, not silent replacement.
