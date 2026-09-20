[CmdletBinding()]
param([string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$package = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repository '.release' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$archive = Join-Path $output "meshrooms-skill-v$version.zip"
$checksums = Join-Path $output 'SHA256SUMS.txt'
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $checksums)) { throw 'Release output exists; use a new directory.' }
$skill = Join-Path $repository 'skills\meshrooms'
foreach ($file in @('SKILL.md', 'LICENSE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $skill $file) -PathType Leaf)) { throw "Missing skill file: $file" }
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
Compress-Archive -LiteralPath $skill -DestinationPath $archive -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($checksums, "$hash  $([IO.Path]::GetFileName($archive))`n", [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ version = $version; archive = $archive; checksums = $checksums; sha256 = $hash } | ConvertTo-Json
