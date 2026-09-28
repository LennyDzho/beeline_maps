param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $projectRoot 'apps/web'
$runtimeRoot = Join-Path $projectRoot '.tmp/local-runtime'
$varsPath = Join-Path $webRoot '.dev.vars'
$pythonPath = Join-Path $projectRoot 'algorithm-research/benchmark/.venv/Scripts/python.exe'
$solverPath = Join-Path $projectRoot 'services/optimizer/server.py'
function Resolve-NodePath {
    if ($env:MARSH_NODE_PATH) {
        if (-not (Test-Path -LiteralPath $env:MARSH_NODE_PATH -PathType Leaf)) {
            throw 'MARSH_NODE_PATH must point to an existing node.exe.'
        }
        return (Resolve-Path -LiteralPath $env:MARSH_NODE_PATH).Path
    }
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($nodeCommand) { return $nodeCommand.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe'),
        (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'Node.js was not found. Install Node.js 22.13 or newer, or set MARSH_NODE_PATH to the full path of node.exe.'
}
$nodePath = Resolve-NodePath
$nodeVersionText = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(\d+\.\d+\.\d+)' -or [version]$Matches[1] -lt [version]'22.13.0') {
    throw 'Node.js 22.13 or newer is required. Set MARSH_NODE_PATH to a supported node.exe.'
}
$webCli = Join-Path $webRoot 'node_modules/vinext/dist/cli.js'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Install services/optimizer/requirements.txt in a Python environment first.' }
& $pythonPath -c "import ortools, pyvrp"
if ($LASTEXITCODE -ne 0) { throw 'Optimizer dependencies are missing. Run: algorithm-research/benchmark/.venv/Scripts/python.exe -m pip install -r services/optimizer/requirements.txt' }
if (-not (Test-Path -LiteralPath $varsPath)) { throw 'The local .dev.vars configuration is required.' }
if (-not (Test-Path -LiteralPath $webCli)) { throw 'Web dependencies are missing. Install the project dependencies first.' }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$varsText = [System.IO.File]::ReadAllText($varsPath)
$urlMatch = [regex]::Match($varsText, '(?m)^OPTIMIZER_SERVICE_URL=(.*)\r?$')
if ($urlMatch.Success -and $urlMatch.Groups[1].Value.Trim().Trim('"').Trim("'") -ne 'http://127.0.0.1:8765') { throw 'A different optimizer URL is configured; it will not be overwritten.' }
$tokenMatch = [regex]::Match($varsText, '(?m)^OPTIMIZER_SERVICE_TOKEN=(.*)\r?$')
if ($tokenMatch.Success) { $solverToken = $tokenMatch.Groups[1].Value.Trim().Trim('"').Trim("'") }
else {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $solverToken = [Convert]::ToBase64String($bytes)
    $varsText = $varsText.TrimEnd() + "`r`nOPTIMIZER_SERVICE_TOKEN=$solverToken`r`n"
}
if ([string]::IsNullOrWhiteSpace($solverToken)) { throw 'Empty optimizer token is not allowed.' }
if (-not $urlMatch.Success) { $varsText += "OPTIMIZER_SERVICE_URL=http://127.0.0.1:8765`r`n" }
[System.IO.File]::WriteAllText($varsPath, $varsText, (New-Object System.Text.UTF8Encoding($false)))

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $task = $client.ConnectAsync('127.0.0.1', $Port); $null = $task.Wait(600); return $client.Connected }
    catch { return $false } finally { $client.Dispose() }
}

$solverProcess = $null
if (-not (Test-LocalPort 8765)) {
    $previousToken = $env:OPTIMIZER_SERVICE_TOKEN
    try {
        $env:OPTIMIZER_SERVICE_TOKEN = $solverToken
        $solverProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-u', ('"' + $solverPath + '"'), '--host', '127.0.0.1', '--port', '8765') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'optimizer.log') -RedirectStandardError (Join-Path $runtimeRoot 'optimizer-error.log')
    } finally { $env:OPTIMIZER_SERVICE_TOKEN = $previousToken }
}
for ($attempt = 0; $attempt -lt 30 -and -not (Test-LocalPort 8765); $attempt++) { Start-Sleep -Milliseconds 500 }
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 5
if ($health.service -ne 'marsh-optimizer' -or $health.protocol -ne 1) { throw 'Unexpected optimizer service on port 8765.' }

$webProcess = $null
if (-not (Test-LocalPort 3000)) {
    $previousPath = $env:PATH
    try {
        # Child tools also invoke node by name, including when started from Explorer.
        $env:PATH = (Split-Path -Parent $nodePath) + [System.IO.Path]::PathSeparator + $previousPath
        $webProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $webCli + '"'), 'dev') -WorkingDirectory $webRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'web.log') -RedirectStandardError (Join-Path $runtimeRoot 'web-error.log')
    } finally { $env:PATH = $previousPath }
}
for ($attempt = 0; $attempt -lt 60 -and -not (Test-LocalPort 3000); $attempt++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-LocalPort 3000)) { throw 'Local web server did not start. See .tmp/local-runtime/web-error.log.' }
$runtimeState = @{ webProcessId = if ($webProcess) { $webProcess.Id } else { $null }; optimizerProcessId = if ($solverProcess) { $solverProcess.Id } else { $null }; startedAt = (Get-Date).ToString('o'); url = 'http://127.0.0.1:3000' }
$runtimeState | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'processes.json') -Encoding UTF8
Write-Output 'Local application: http://127.0.0.1:3000; Optimizers (OR-Tools / PyVRP): http://127.0.0.1:8765'
