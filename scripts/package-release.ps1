$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectDirectory 'manifest.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw | ConvertFrom-Json
$versions = Get-Content -LiteralPath (Join-Path $projectDirectory 'versions.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $package.version -or $versions.($manifest.version) -ne $manifest.minAppVersion) {
  throw 'Release version or minimum Obsidian version metadata is inconsistent.'
}
$releaseDirectory = Join-Path $projectDirectory 'dist'
$pluginDirectory = Join-Path $releaseDirectory 'vaultsail'
New-Item -ItemType Directory -Force -Path $pluginDirectory | Out-Null
foreach ($pluginFile in @('main.js', 'manifest.json', 'styles.css')) {
  $sourceFile = Join-Path $projectDirectory $pluginFile
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Missing build asset: $pluginFile" }
  Copy-Item -LiteralPath $sourceFile -Destination $pluginDirectory
}
$zipPath = Join-Path $releaseDirectory ('vaultsail-' + $manifest.version + '.zip')
Compress-Archive -LiteralPath $pluginDirectory -DestinationPath $zipPath -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $expectedEntries = @('vaultsail/main.js', 'vaultsail/manifest.json', 'vaultsail/styles.css') | Sort-Object
  $actualEntries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }) | Sort-Object
  if (Compare-Object $expectedEntries $actualEntries) { throw 'ZIP contains missing or unexpected files.' }
} finally { $archive.Dispose() }
$assetPaths = @((Join-Path $pluginDirectory 'main.js'), (Join-Path $pluginDirectory 'manifest.json'), (Join-Path $pluginDirectory 'styles.css'), $zipPath)
$checksums = $assetPaths | ForEach-Object { $asset = Get-FileHash -LiteralPath $_ -Algorithm SHA256; $asset.Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $_) }
Set-Content -LiteralPath (Join-Path $releaseDirectory 'SHA256SUMS.txt') -Value $checksums -Encoding utf8
Write-Output ('Package verified: ' + $zipPath)
