param(
  [Parameter(Mandatory = $true)]
  [string]$Root,

  [Parameter(Mandatory = $true)]
  [string]$Output
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
$rootPrefix = $resolvedRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) +
  [IO.Path]::DirectorySeparatorChar

$entries = Get-ChildItem -LiteralPath $resolvedRoot -File -Force -Recurse |
  ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($rootPrefix.Length).Replace('\', '/')
      size = $_.Length
      mtimeUtc = $_.LastWriteTimeUtc.ToString('o')
    }
  } |
  Sort-Object -Property path

$parent = Split-Path -Parent $Output
if ($parent) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$entries | ConvertTo-Json -Depth 3 -Compress | Set-Content -LiteralPath $Output -Encoding utf8
Write-Output "snapshot_files=$($entries.Count)"
Write-Output "snapshot_output=$Output"
