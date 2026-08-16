[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,
  [Parameter(Mandatory = $true)]
  [string]$Arguments,
  [Parameter(Mandatory = $true)]
  [string]$StdoutPath,
  [Parameter(Mandatory = $true)]
  [string]$StderrPath,
  [Parameter(Mandatory = $true)]
  [string]$ExitPath,
  [string]$WorkingDirectory = (Get-Location).Path,
  [switch]$NoExit
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Content
  )

  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $FilePath
$startInfo.Arguments = $Arguments
$startInfo.WorkingDirectory = $WorkingDirectory
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = $utf8NoBom
$startInfo.StandardErrorEncoding = $utf8NoBom

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
[void]$process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()

Write-Utf8NoBom -Path $StdoutPath -Content $stdoutTask.GetAwaiter().GetResult()
Write-Utf8NoBom -Path $StderrPath -Content $stderrTask.GetAwaiter().GetResult()
Write-Utf8NoBom -Path $ExitPath -Content ("{0}`n" -f $process.ExitCode)
if ($NoExit) {
  return $process.ExitCode
}
exit $process.ExitCode
