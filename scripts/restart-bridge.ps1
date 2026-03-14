param(
  [string]$WorkingDirectory = "C:\trae project\Economic",
  [string]$NodeExe = ""
)

function Resolve-RealNodeExe {
  param([string]$Preferred)

  if ($Preferred -and (Test-Path $Preferred)) {
    return $Preferred
  }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and $command.Source.ToLower().EndsWith("node.exe")) {
    return $command.Source
  }

  $whereNode = & where.exe node 2>$null | Where-Object { $_.ToLower().EndsWith(".exe") } | Select-Object -First 1
  if ($whereNode -and (Test-Path $whereNode)) {
    return $whereNode
  }

  if ($command -and $command.Source -and $command.Source.ToLower().EndsWith("node.cmd")) {
    $candidate = [System.IO.Path]::ChangeExtension($command.Source, ".exe")
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  $wingetNode = Get-ChildItem `
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") `
    -Recurse `
    -Filter node.exe `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*node-v*-win-x64\\node.exe" } |
    Select-Object -First 1 -ExpandProperty FullName

  if ($wingetNode) {
    return $wingetNode
  }

  throw "Could not find a real node.exe. Pass -NodeExe explicitly."
}

$resolvedNode = Resolve-RealNodeExe -Preferred $NodeExe
$scriptPath = Join-Path $WorkingDirectory "dist\index.js"
$stdoutPath = Join-Path $WorkingDirectory "logs\bridge-stdout.log"
$stderrPath = Join-Path $WorkingDirectory "logs\bridge-stderr.log"
$bridgeLogPath = Join-Path $WorkingDirectory "logs\bridge.log"

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match "dist/index\.js" -or
    $_.CommandLine -match "dist\\index\.js" -or
    $_.CommandLine -match "node_modules\\@openai\\codex\\bin\\codex\.js"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 2

$process = Start-Process `
  -FilePath $resolvedNode `
  -ArgumentList "dist/index.js" `
  -WorkingDirectory $WorkingDirectory `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru `
  -WindowStyle Hidden

Start-Sleep -Seconds 3

Write-Host "Started Feishu Codex operator. PID: $($process.Id)"
Write-Host "Node: $resolvedNode"

if (Test-Path $bridgeLogPath) {
  Write-Host ""
  Write-Host "Recent bridge log:"
  Get-Content $bridgeLogPath -Tail 12
}
