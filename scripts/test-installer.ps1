$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = Join-Path ([IO.Path]::GetTempPath()) ('meshrooms-installer-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$installer = Join-Path $PSScriptRoot '../skills/meshrooms/scripts/install.ps1'
$version = 'v0.1.0-alpha.1'
$asset = "meshrooms-$version-windows-x64.zip"
$hash = [Security.Cryptography.SHA256]::Create()
function Hash-Text([string]$Text) { -join ($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) }
$baseFiles = @{ 'server/cli.ts' = '// cli'; 'server/daemon.ts' = '// daemon'; 'dist/index.html' = '<html />'; '.local/native/wormdb_ffi.dll' = 'fixture'; 'LICENSE' = 'fixture'; 'LICENSES/wormdb.txt' = 'fixture'; 'THIRD_PARTY_NOTICES.md' = 'fixture' }
$passed = 0
function Case([string]$CaseName, [string]$Expected, [string]$Mode) {
    $dir = Join-Path $root $CaseName
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $files = $baseFiles.Clone()
    $hashes = @{}
    foreach ($name in $files.Keys) { $hashes[$name] = Hash-Text $files[$name] }
    $manifest = @{ schema = 1; version = '0.1.0-alpha.1'; platform = 'win32'; arch = 'x64'; git = @{ dirty = $false; releaseCommit = ('a' * 40) }; bun = @{ bundled = $false; version = '1.4.2' }; files = $hashes }
    switch ($Mode) {
        'traversal' { $files['../escaped.txt'] = 'escape' }
        'unlisted' { $files['control.key'] = 'should be rejected' }
        'tampered' { $files['server/cli.ts'] = 'changed bytes' }
        'missing' { $files.Remove('server/cli.ts') }
        'dirty' { $manifest.git.dirty = $true }
    }
    $files['manifest.json'] = $manifest | ConvertTo-Json -Depth 6 -Compress
    $zipPath = Join-Path $dir $asset
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $files.Keys) {
            $entry = $zip.CreateEntry($name)
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try { $writer.Write($files[$name]) } finally { $writer.Dispose() }
        }
        if ($Mode -eq 'case-collision') { $zip.CreateEntry('SERVER/cli.ts') | Out-Null }
    } finally { $zip.Dispose() }
    $sum = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Mode -eq 'checksum') { $sum = '0' * 64 }
    $sumPath = Join-Path $dir 'SHA256SUMS.txt'
    [IO.File]::WriteAllText($sumPath, "$sum  $asset`n")
    $badBun = Join-Path $dir 'bun.zip'
    [IO.File]::WriteAllText($badBun, 'invalid upstream binary')
    $target = Join-Path $dir 'app'
    if ($Mode -eq 'exists') { [IO.Directory]::CreateDirectory($target) | Out-Null; [IO.File]::WriteAllText((Join-Path $target 'sentinel'), 'untouched') }
    $failed = $false
    try { & $installer -Version $version -InstallDir $target -ArchivePath $zipPath -ChecksumPath $sumPath -BunArchivePath $badBun | Out-Null }
    catch { $failed = $true; if ($_.Exception.Message -notmatch $Expected) { throw "${CaseName}: unexpected error: $($_.Exception.Message)" } }
    if (-not $failed) { throw "${CaseName}: installer unexpectedly succeeded" }
    if ($Mode -eq 'exists') {
        if ([IO.File]::ReadAllText((Join-Path $target 'sentinel')) -cne 'untouched') { throw 'Existing runtime modified' }
    } elseif (Test-Path -LiteralPath $target) { throw "${CaseName}: failed installation left a live app directory" }
    if (Test-Path -LiteralPath (Join-Path $dir 'escaped.txt')) { throw 'Archive escaped staging' }
    $script:passed++
}
try {
    Case 'checksum' 'SHA-256 mismatch' 'checksum'
    Case 'traversal' 'Unsafe archive path' 'traversal'
    Case 'unlisted' 'files absent from its manifest' 'unlisted'
    Case 'tampered' 'SHA-256 mismatch' 'tampered'
    Case 'missing' 'files absent from its manifest' 'missing'
    Case 'dirty' 'clean release' 'dirty'
    Case 'collision' 'Duplicate archive path' 'case-collision'
    Case 'bun' 'SHA-256 mismatch' 'bun'
    Case 'existing' 'Runtime already exists' 'exists'
    "Installer rejection checks: $passed passed"
} finally {
    $hash.Dispose()
    $resolved = [IO.Path]::GetFullPath($root)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($resolved) -eq $temp -and [IO.Path]::GetFileName($resolved) -match '^meshrooms-installer-test-[0-9a-f]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
