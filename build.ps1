# DSH Portable 构建系统 —— 自举入口(Windows / PowerShell)
#
# build.sh 的双胞胎。职责完全相同:探测本机 os/arch,把固定版 Node 拉到
# .toolchain/ 里,然后把控制权交给 lib/build.mjs。
#
# 真正的构建逻辑只有 lib/build.mjs 一份,这里不做任何业务判断 ——
# 引导层是唯一必须双写的部分,因为 sh 和 PowerShell 各自只在本平台保证存在。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Targets win-x64 -Archive

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeVersion = if ($env:DSH_BUILD_NODE_VERSION) { $env:DSH_BUILD_NODE_VERSION } else { 'v24.19.0' }
$NodeMirror  = if ($env:DSH_BUILD_NODE_MIRROR)  { $env:DSH_BUILD_NODE_MIRROR }  else { 'https://nodejs.org/dist' }
$Toolchain   = Join-Path $Root '.toolchain'

# ── 探测宿主架构 ──────────────────────────────────────────────────────────
$HostArch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'x86'   { if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw '不支持 32 位 Windows' } }
    default { throw "不支持的宿主架构: $env:PROCESSOR_ARCHITECTURE" }
}
$HostTarget = "win-$HostArch"
$Archive = "node-$NodeVersion-win-$HostArch.zip"
$NodeDir = Join-Path $Toolchain "node-$NodeVersion-win-$HostArch"
$NodeBin = Join-Path $NodeDir 'node.exe'

# ── 拉取并校验宿主 Node(已存在则跳过)─────────────────────────────────────
if (-not (Test-Path $NodeBin)) {
    Write-Host "==> 自举:下载 Node $NodeVersion ($HostTarget)"
    $downloads = Join-Path $Toolchain 'downloads'
    New-Item -ItemType Directory -Path $downloads -Force | Out-Null
    $dl = Join-Path $downloads $Archive
    if (-not (Test-Path $dl)) {
        Invoke-WebRequest -Uri "$NodeMirror/$NodeVersion/$Archive" -OutFile $dl -UseBasicParsing
    }

    # 用官方 SHASUMS256.txt 校验完整性
    $sums = Join-Path $downloads "SHASUMS256-$NodeVersion.txt"
    if (-not (Test-Path $sums)) {
        Invoke-WebRequest -Uri "$NodeMirror/$NodeVersion/SHASUMS256.txt" -OutFile $sums -UseBasicParsing
    }
    $want = $null
    foreach ($line in Get-Content $sums) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Length -ge 2 -and $parts[1] -eq $Archive) { $want = $parts[0]; break }
    }
    if (-not $want) { throw "SHASUMS256.txt 里找不到 $Archive" }
    $got = (Get-FileHash -Path $dl -Algorithm SHA256).Hash.ToLower()
    if ($want.ToLower() -ne $got) {
        Remove-Item $dl -Force
        throw "Node 校验失败:期望 $want,实际 $got"
    }
    Write-Host "    校验通过 $($want.Substring(0,12))…"

    Expand-Archive -Path $dl -DestinationPath $Toolchain -Force
    if (-not (Test-Path $NodeBin)) { throw "解压后仍找不到 node: $NodeBin" }
}

Write-Host "==> 自举完成:$(& $NodeBin --version) ($HostTarget)"
$buildScript = Join-Path $Root 'lib\build.mjs'
& $NodeBin $buildScript --host $HostTarget @Rest
exit $LASTEXITCODE
