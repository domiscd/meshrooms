# Install a pinned Windows x64 preview without modifying an existing node.
[CmdletBinding()]
param(
    [string]$Version = 'v0.1.0-alpha.3',
    [string]$InstallDir,
    [string]$ArchivePath,
    [string]$ChecksumPath,
    [string]$BunArchivePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Use 64-bit PowerShell on Windows x64.' }
if ($Version -cnotmatch '^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid release version.' }
if ([bool]$ArchivePath -ne [bool]$ChecksumPath) { throw 'Offline installation requires both -ArchivePath and -ChecksumPath.' }
if (-not $InstallDir) {
    $InstallDir = if ($env:MESHROOMS_HOME) { $env:MESHROOMS_HOME } else { Join-Path $env:USERPROFILE '.meshrooms\app' }
}
$destination = [IO.Path]::GetFullPath($InstallDir)
if (Test-Path -LiteralPath $destination) { throw "Runtime already exists at $destination. Reuse it; this installer does not upgrade or overwrite installations." }
$parent = [IO.Path]::GetDirectoryName($destination)
if (-not $parent) { throw 'InstallDir must name an application directory.' }
# Refuse junctions/symlinks in the destination chain so staging cannot land in another node.
$ancestor = $parent
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Install directory ancestors must not be links or junctions.' }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
[IO.Directory]::CreateDirectory($parent) | Out-Null
$stage = Join-Path $parent ('.meshrooms-install-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

function Assert-Hash([string]$Path, [string]$Expected) {
    if ($Expected -cnotmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) { throw "SHA-256 mismatch: $([IO.Path]::GetFileName($Path))" }
}

function Expand-CheckedZip([string]$Path, [string]$Target) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        if ($zip.Entries.Count -gt 4096) { throw 'Archive contains too many entries.' }
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            # Windows normalization, ADS, traversal, device names, and Unix link entries.
            if ($name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Contains([char]0)) { throw "Unsafe archive path: $name" }
            $parts = $name.TrimEnd('/').Split('/')
            foreach ($part in $parts) {
                if ($part -eq '' -or $part -in '.', '..' -or $part -match '[. ]$' -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw "Unsafe archive path: $name" }
            }
            if (-not $names.Add($name.TrimEnd('/'))) { throw "Duplicate archive path: $name" }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive links are not supported.' }
            $total += $entry.Length
            if ($total -gt 536870912) { throw 'Archive exceeds the 512 MiB extraction limit.' }
        }
        [IO.Directory]::CreateDirectory($Target) | Out-Null
        foreach ($entry in $zip.Entries) {
            $file = [IO.Path]::GetFullPath((Join-Path $Target $entry.FullName))
            if (-not $file.StartsWith($Target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escaped its extraction directory.' }
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($file) | Out-Null; continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $file, $false)
        }
    } finally { $zip.Dispose() }
}

try {
    $assetName = "meshrooms-$Version-windows-x64.zip"
    if (-not $ArchivePath) {
        $baseUrl = "https://github.com/igorls/meshrooms/releases/download/$Version"
        $ArchivePath = Join-Path $stage $assetName
        $ChecksumPath = Join-Path $stage 'SHA256SUMS.txt'
        Invoke-WebRequest "$baseUrl/SHA256SUMS.txt" -OutFile $ChecksumPath -UseBasicParsing
        Invoke-WebRequest "$baseUrl/$assetName" -OutFile $ArchivePath -UseBasicParsing
    }
    $matches = @(Get-Content -LiteralPath $ChecksumPath | Where-Object { $_ -cmatch ('^[0-9a-f]{64}  ' + [regex]::Escape($assetName) + '$') })
    if ($matches.Count -ne 1) { throw 'Checksum file must contain exactly one entry for the requested release asset.' }
    Assert-Hash $ArchivePath $matches[0].Substring(0, 64)
    $app = Join-Path $stage 'app'
    Expand-CheckedZip $ArchivePath $app
    $manifest = Get-Content -LiteralPath (Join-Path $app 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.platform -cne 'win32' -or $manifest.arch -cne 'x64' -or "v$($manifest.version)" -cne $Version -or $manifest.git.dirty -ne $false -or $manifest.git.releaseCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Manifest does not describe a clean release of the requested version.' }
    if ($manifest.bun.bundled -ne $false -or $manifest.bun.version -cne '1.4.2') { throw 'Unsupported Bun dependency in release manifest.' }
    $files = @($manifest.files.PSObject.Properties)
    $actual = @(Get-ChildItem -LiteralPath $app -Recurse -File -Force)
    if ($actual.Count -ne $files.Count + 1) { throw 'Archive contains files absent from its manifest.' }
    $listed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $files) {
        $relative = $file.Name
        if ($relative -eq 'manifest.json' -or $relative.Contains('\') -or $relative -match '(^/|:|(^|/)\.\.?(/|$))' -or -not $listed.Add($relative)) { throw 'Invalid manifest file path.' }
        $full = [IO.Path]::GetFullPath((Join-Path $app $relative))
        if (-not $full.StartsWith($app + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escaped archive.' }
        Assert-Hash $full $file.Value
    }
    foreach ($required in @('server/cli.ts', 'server/daemon.ts', 'dist/index.html', '.local/native/wormdb_ffi.dll', 'LICENSE', 'LICENSES/wormdb.txt', 'THIRD_PARTY_NOTICES.md')) {
        if (-not $listed.Contains($required)) { throw "Release is missing $required" }
    }
    if (Test-Path -LiteralPath (Join-Path $app 'bun.exe')) { throw 'Release unexpectedly bundles Bun.' }
    if (-not $BunArchivePath) {
        $BunArchivePath = Join-Path $stage 'bun-windows-x64.zip'
        Invoke-WebRequest 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64.zip' -OutFile $BunArchivePath -UseBasicParsing
    }
    Assert-Hash $BunArchivePath 'ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405'
    $bunStage = Join-Path $stage 'bun'
    Expand-CheckedZip $BunArchivePath $bunStage
    Copy-Item -LiteralPath (Join-Path $bunStage 'bun-windows-x64/bun.exe') -Destination (Join-Path $app 'bun.exe')
    $receipt = @{ version = $Version; sourceCommit = $manifest.git.releaseCommit; bunVersion = '1.4.2'; bunSha256 = (Get-FileHash -LiteralPath (Join-Path $app 'bun.exe') -Algorithm SHA256).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText((Join-Path $app 'install-receipt.json'), ($receipt | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    # Directory.Move refuses an existing destination, including a concurrent install.
    [IO.Directory]::Move($app, $destination)
    @{ installed = $true; directory = $destination; version = $Version; sourceCommit = $manifest.git.releaseCommit; started = $false } | ConvertTo-Json
} finally {
    # Only our fresh sibling staging directory is eligible for cleanup.
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if ([IO.Path]::GetDirectoryName($resolvedStage) -eq $parent -and [IO.Path]::GetFileName($resolvedStage) -match '^\.meshrooms-install-[0-9a-f]{32}$' -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
