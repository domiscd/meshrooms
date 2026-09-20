# Third-party notices

The root MIT license covers Meshrooms source and its agent skill. Dependencies retain their own licenses.

| Component | Version | License / notice |
| --- | --- | --- |
| React | 19.3.0 | [MIT](LICENSES/react.txt) |
| React DOM | 19.3.0 | [MIT](LICENSES/react-dom.txt) |
| Scheduler | 0.28.0 | [MIT](LICENSES/scheduler.txt) |
| Manrope variable font | package 5.3.0 | [SIL Open Font License 1.1](LICENSES/manrope.txt) |
| WormDB Windows library | pinned in native/wormdb.lock.json | [MIT for the distributed binary](LICENSES/wormdb.txt) |
| MeshGuard native dependency | pinned in native/wormdb.lock.json | [MIT](LICENSES/meshguard.txt) |
| Zig standard library | 0.16.0 | [MIT](LICENSES/zig.txt) |
| MinGW runtime support shipped with Zig | Zig 0.16.0 distribution | [Component notices](LICENSES/mingw.txt) |
| Bun, fetched separately by the installer | 1.4.2 | [Upstream notices](LICENSES/bun.txt), including linked libraries |

WormDB is intended to become open source. Its source repository remains private while that release is prepared. Its author grants the accompanying MIT license for the WormDB binary distributed in this preview. This repository and its archives contain no private WormDB source or patches.

The public app archive does not redistribute Bun. The installer downloads the pinned executable archive directly from [Bun's upstream release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) and verifies its SHA-256. Bun's [source and build instructions](https://github.com/oven-sh/bun/tree/bun-v1.4.2) and retained upstream notice describe its linked dependencies and relinking procedure.

Development tools are installed through the lockfile and retain their upstream licenses. Standalone skill archives contain no runtime binaries.
