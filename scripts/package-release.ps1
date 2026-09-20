[CmdletBinding()]
param([string]$OutputDirectory, [string]$NativeDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = Split-Path $PSScriptRoot -Parent
$previousLibrary = $env:WORMDB_LIBRARY_PATH
Push-Location $repository
try {
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    if ($version -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid version.' }
    $status = git status --porcelain
    if ($LASTEXITCODE -ne 0 -or $status) { throw 'Commit the reviewed release tree before packaging.' }
    if ((bun --version).Trim() -cne '1.4.2') { throw 'Packaging requires Bun 1.4.2.' }
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repository ".release/v$version" }
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path -LiteralPath $output) { throw 'Release directory already exists. Use a new directory.' }
    foreach ($notice in @('LICENSES/wormdb.txt', 'LICENSES/zig.txt', 'LICENSES/meshguard.txt')) {
        if (-not (Test-Path -LiteralPath $notice)) { throw "Missing native notice: $notice" }
    }
    if (-not $NativeDirectory) { $NativeDirectory = Join-Path $repository '.local/native' }
    $native = [IO.Path]::GetFullPath($NativeDirectory)
    & "$PSScriptRoot/build-native.ps1" -VerifyOnly -OutDir $native
    if ($LASTEXITCODE -ne 0) { throw 'Native verification failed.' }
    $env:WORMDB_LIBRARY_PATH = Join-Path $native 'wormdb_ffi.dll'
    bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    bun run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    bun run test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    & "$PSScriptRoot/package-skill.ps1" -OutputDirectory $output | Out-Null
    $runtime = Join-Path $output 'runtime'
    bun run scripts/package-runtime.ts --out $runtime --external-bun --library $env:WORMDB_LIBRARY_PATH
    if ($LASTEXITCODE -ne 0) { throw 'Runtime packaging failed.' }
    $manifest = Get-Content -LiteralPath (Join-Path $runtime 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.git.dirty -or -not $manifest.git.releaseCommit) { throw 'Runtime was not built from a clean commit.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = Join-Path $output "meshrooms-v$version-windows-x64.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($runtime, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
    Copy-Item -LiteralPath (Join-Path $repository 'native/wormdb.lock.json') -Destination (Join-Path $output 'wormdb.lock.json')
    $lines = @(Get-ChildItem -LiteralPath $output -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object Name | ForEach-Object {
        (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name
    })
    [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    @{ version = $version; directory = $output; commit = $manifest.git.releaseCommit } | ConvertTo-Json
} finally { $env:WORMDB_LIBRARY_PATH = $previousLibrary; Pop-Location }
