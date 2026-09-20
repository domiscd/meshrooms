# Native Windows build

The release includes an MIT-licensed WormDB DLL. WormDB will become open source;
its source remains private while that release is prepared. This public repository
contains the input pins and build procedure, without private source or patches.

Maintainers with access to a clean private checkout can run:

```powershell
./scripts/build-native.ps1 -SourceDir <private-checkout> -OutDir <fresh-output-directory>
./scripts/build-native.ps1 -VerifyOnly
```

The first command requires Windows x64 and Zig 0.16.0. It checks both source
commits in [the lockfile](../native/wormdb.lock.json), exports their tracked files
into a fresh ignored scratch directory, and compiles only the FFI library in
ReleaseFast mode. The project cache and compiler output stay in that scratch
directory; Zig's shared toolchain cache is reused.
It refuses an existing output DLL and records the resulting size and SHA-256.
PE build identifiers can change across build directories, so this is not a
promise of bit-identical rebuilding. A provenance JSON accompanies
the candidate output; it contains no machine paths. Scratch input remains private under
`.local/native-build` and must never be published.

The second command verifies the exact reviewed hash of `.local/native/wormdb_ffi.dll`,
or a supplied `-OutDir`, without compiling. Packaging requires that exact match.
Public users can obtain that library from the
versioned app archive after checking `SHA256SUMS.txt`.

The pinned Windows build selects Zig `std.crypto` and does not link libsodium.
Inspection with `llvm-readobj --coff-imports` found KERNEL32, ntdll, and the Windows
Universal CRT heap/runtime/stdio/string API sets. It requires no separately shipped
crypto DLL. The build input also contains the pinned public MeshGuard module.
Dependency notices for MeshGuard, Zig, and MinGW runtime support accompany the
WormDB binary license in [LICENSES](../LICENSES).

The exact locked DLL must pass Meshrooms' native integration and process-recovery
tests. A new compiler, native commit, or binary hash needs a new reviewed lockfile
and qualification; never change the expected hash just to make a build pass.
