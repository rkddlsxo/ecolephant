[CmdletBinding()]
param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$checkerPath = Join-Path $PSScriptRoot 'check.py'
$repoPath = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if ($PythonPath) {
    & $PythonPath $checkerPath
} elseif (Test-Path -LiteralPath (Join-Path $repoPath '.venv/Scripts/python.exe')) {
    & (Join-Path $repoPath '.venv/Scripts/python.exe') $checkerPath
} elseif (Test-Path -LiteralPath (Join-Path $repoPath '.venv/bin/python')) {
    & (Join-Path $repoPath '.venv/bin/python') $checkerPath
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $checkerPath
} else {
    & python3 $checkerPath
}
if ($LASTEXITCODE -ne 0) { throw '백엔드 하네스 검사에 실패했습니다.' }
