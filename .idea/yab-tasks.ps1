param(
    [Parameter(Mandatory)]
    [ValidateSet('prepare', 'web', 'desktop', 'check', 'smoke', 'pack', 'dist')]
    [string] $Task,
    [switch] $Preview
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
# 本机运行配置显式使用已有工具，不修改系统环境或下载新环境。
$toolDirectories = @(
    (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin')
    (Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/Links')
    'D:/nodejs/npm/global'
)
$env:Path = ($toolDirectories -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:Path
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUNBUFFERED = '1'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Invoke-YabCommand {
    param([Parameter(ValueFromRemainingArguments)][string[]] $Command)
    Write-Host ("`n> " + ($Command -join ' '))
    if ($Preview) { return }
    $executable = $Command[0]
    $arguments = $Command | Select-Object -Skip 1
    & $executable @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Initialize-YabDependencies {
    Invoke-YabCommand uv sync --python 3.11
    Invoke-YabCommand pnpm.cmd --dir webapp install --frozen-lockfile
    Invoke-YabCommand pnpm.cmd --dir desktop install --frozen-lockfile
}

function Test-YabProject {
    Invoke-YabCommand pnpm.cmd --dir webapp run check
    Invoke-YabCommand pnpm.cmd --dir desktop test
}

# 首次发行前，先运行网页入口，等待识别服务准备完成再停止。
# pack（应用目录）和 dist（完整发行）均先准备依赖、检查，再构建。
switch ($Task) {
    'prepare' { Initialize-YabDependencies }
    'web' { Invoke-YabCommand uv run python -m server --open }
    'desktop' {
        Invoke-YabCommand uv run python -m server.frontend
        Invoke-YabCommand pnpm.cmd --dir desktop start
    }
    'check' { Test-YabProject }
    'smoke' {
        Invoke-YabCommand uv run python -m server.frontend
        Invoke-YabCommand pnpm.cmd --dir desktop run smoke
    }
    'pack' {
        Initialize-YabDependencies
        Test-YabProject
        Invoke-YabCommand pnpm.cmd --dir desktop run pack
    }
    'dist' {
        Initialize-YabDependencies
        Test-YabProject
        Invoke-YabCommand pnpm.cmd --dir desktop run dist
    }
}
