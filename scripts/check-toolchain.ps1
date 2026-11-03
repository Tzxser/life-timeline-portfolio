[CmdletBinding()]
param(
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

function Get-ExecutablePath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandType -in @('Application', 'ExternalScript') } |
        Select-Object -First 1
    if ($null -eq $command) {
        return $null
    }
    return $command.Source
}

function Invoke-VersionCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    try {
        $output = (& $Path @Arguments 2>&1 | Out-String).Trim()
        return [ordered]@{
            ok      = ($LASTEXITCODE -eq 0)
            output  = $output
            exitCode = $LASTEXITCODE
        }
    }
    catch {
        return [ordered]@{
            ok      = $false
            output  = $_.Exception.Message
            exitCode = $null
        }
    }
}

function Get-FirstExistingPath {
    param([Parameter(Mandatory = $true)][string[]]$Candidates)

    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-VsWherePath {
    $fromPath = Get-ExecutablePath -Name 'vswhere.exe'
    if ($fromPath) {
        return $fromPath
    }

    $programFilesX86 = ${env:ProgramFiles(x86)}
    $programFiles = ${env:ProgramFiles}
    $candidates = @(
        $(if ($programFilesX86) { Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe' }),
        $(if ($programFiles) { Join-Path $programFiles 'Microsoft Visual Studio\Installer\vswhere.exe' })
    )
    return Get-FirstExistingPath -Candidates $candidates
}

function Get-VisualStudioInstallationPath {
    $vswhere = Get-VsWherePath
    if ($vswhere) {
        try {
            $path = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null |
                Select-Object -First 1).ToString().Trim()
            if ($path -and (Test-Path -LiteralPath $path -PathType Container)) {
                return [ordered]@{ path = $path; source = $vswhere }
            }
        }
        catch {
            # Fall through to the deterministic installation-path search below.
        }
    }

    $roots = @()
    if (${env:ProgramFiles}) {
        $roots += Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\2022'
    }
    if (${env:ProgramFiles(x86)}) {
        $roots += Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022'
    }

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }
        $installation = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $cl = Get-ChildItem -LiteralPath $_.FullName -Filter 'cl.exe' -File -Recurse -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -match '\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\cl\.exe$' } |
                    Select-Object -First 1
                if ($cl) { return $_.FullName }
            } |
            Select-Object -First 1
        if ($installation) {
            return [ordered]@{ path = $installation; source = 'filesystem search' }
        }
    }

    return $null
}

function Get-MsvcDetails {
    $installation = Get-VisualStudioInstallationPath
    $clFromPath = Get-ExecutablePath -Name 'cl.exe'
    $linkFromPath = Get-ExecutablePath -Name 'link.exe'
    $rcFromPath = Get-ExecutablePath -Name 'rc.exe'

    $clCandidates = @($clFromPath)
    $linkCandidates = @($linkFromPath)
    $rcCandidates = @($rcFromPath)

    if ($installation) {
        $clCandidates += Join-Path $installation.path 'VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe'
        $linkCandidates += Join-Path $installation.path 'VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe'
        $rcCandidates += Join-Path $installation.path 'SDK\*\bin\*\x64\rc.exe'
    }

    $clPath = $null
    $linkPath = $null
    $rcPath = $null
    foreach ($pattern in $clCandidates) {
        if (-not $pattern) { continue }
        $match = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '(?i)\\bin\\Hostx64\\x64\\cl\.exe$' } |
            Select-Object -First 1
        if ($match) { $clPath = $match.FullName; break }
    }
    foreach ($pattern in $linkCandidates) {
        if (-not $pattern) { continue }
        $match = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '(?i)\\bin\\Hostx64\\x64\\link\.exe$' } |
            Select-Object -First 1
        if ($match) { $linkPath = $match.FullName; break }
    }
    foreach ($pattern in $rcCandidates) {
        if (-not $pattern) { continue }
        $match = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '(?i)\\x64\\rc\.exe$' } |
            Select-Object -First 1
        if ($match) { $rcPath = $match.FullName; break }
    }

    # Some VS installations expose the Windows SDK outside the VS installation
    # directory. Check the canonical Windows Kits path as a fallback.
    if (-not $rcPath) {
        $kitsRoot = if (${env:ProgramFiles(x86)}) {
            Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
        }
        else {
            Join-Path ${env:ProgramFiles} 'Windows Kits\10\bin'
        }
        if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
            $rc = Get-ChildItem -LiteralPath $kitsRoot -Filter 'rc.exe' -File -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\rc\.exe$' } |
                Sort-Object FullName -Descending |
                Select-Object -First 1
            if ($rc) { $rcPath = $rc.FullName }
        }
    }

    $msvcRoot = $null
    $msvcVersion = $null
    if ($clPath -and ($clPath -match '(?i)^(?<root>.*\\VC\\Tools\\MSVC\\[^\\]+)\\bin\\Hostx64\\x64\\cl\.exe$')) {
        $msvcRoot = $Matches.root
        $msvcVersion = Split-Path -Leaf $msvcRoot
    }

    $windowsSdkRoot = $null
    $windowsSdkVersion = $null
    if ($rcPath -and ($rcPath -match '(?i)^(?<root>.*\\Windows Kits\\10)\\bin\\(?<version>[^\\]+)\\x64\\rc\.exe$')) {
        $windowsSdkRoot = $Matches.root
        $windowsSdkVersion = $Matches.version
    }

    $msvcLib = if ($msvcRoot) { Join-Path $msvcRoot 'lib\x64' } else { $null }
    $msvcInclude = if ($msvcRoot) { Join-Path $msvcRoot 'include' } else { $null }
    $sdkUcrtLib = if ($windowsSdkRoot -and $windowsSdkVersion) {
        Join-Path $windowsSdkRoot ("Lib\$windowsSdkVersion\ucrt\x64")
    }
    else { $null }
    $sdkUmLib = if ($windowsSdkRoot -and $windowsSdkVersion) {
        Join-Path $windowsSdkRoot ("Lib\$windowsSdkVersion\um\x64")
    }
    else { $null }
    $sdkIncludes = if ($windowsSdkRoot -and $windowsSdkVersion) {
        @(
            (Join-Path $windowsSdkRoot ("Include\$windowsSdkVersion\ucrt")),
            (Join-Path $windowsSdkRoot ("Include\$windowsSdkVersion\shared")),
            (Join-Path $windowsSdkRoot ("Include\$windowsSdkVersion\um")),
            (Join-Path $windowsSdkRoot ("Include\$windowsSdkVersion\winrt"))
        )
    }
    else { @() }

    return [ordered]@{
        visualStudio = if ($installation) { $installation.path } else { $null }
        vswhere = if ($installation) { $installation.source } else { $null }
        cl = $clPath
        link = $linkPath
        windowsSdkResourceCompiler = $rcPath
        msvcRoot = $msvcRoot
        msvcVersion = $msvcVersion
        msvcInclude = $msvcInclude
        msvcLib = $msvcLib
        windowsSdkRoot = $windowsSdkRoot
        windowsSdkVersion = $windowsSdkVersion
        windowsSdkIncludes = $sdkIncludes
        windowsSdkUcrtLib = $sdkUcrtLib
        windowsSdkUmLib = $sdkUmLib
        found = [bool]($clPath -and $linkPath -and $rcPath)
    }
}

function Invoke-MsvcLinkProbe {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Details)

    $result = [ordered]@{
        ok = $false
        mode = '/MD'
        source = $null
        executable = $null
        exitCode = $null
        output = $null
        missingPaths = @()
    }

    $requiredPaths = @(
        $Details.cl,
        $Details.link,
        $Details.msvcInclude,
        $Details.msvcLib,
        $Details.windowsSdkIncludes,
        $Details.windowsSdkUcrtLib,
        $Details.windowsSdkUmLib
    )
    $result.missingPaths = @($requiredPaths | Where-Object {
        -not $_ -or -not (Test-Path -LiteralPath $_ -PathType Leaf -ErrorAction SilentlyContinue) -and
        -not (Test-Path -LiteralPath $_ -PathType Container -ErrorAction SilentlyContinue)
    })
    $result.missingPaths = @($result.missingPaths | Where-Object { $_ })
    if ($result.missingPaths.Count -gt 0) {
        $result.output = 'Required MSVC/Windows SDK include or library path is missing.'
        return $result
    }

    $probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('life-timeline-msvc-probe-' + [guid]::NewGuid().ToString('N'))
    $source = Join-Path $probeRoot 'probe.c'
    $object = Join-Path $probeRoot 'probe.obj'
    $executable = Join-Path $probeRoot 'probe.exe'
    $result.source = $source
    $result.executable = $executable
    $oldInclude = $env:INCLUDE
    $oldLib = $env:LIB
    $oldPath = $env:PATH
    try {
        New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
        @'
#include <windows.h>
int main(void) {
    return GetModuleHandleW(NULL) == NULL ? 1 : 0;
}
'@ | Set-Content -LiteralPath $source -Encoding ascii

        $env:INCLUDE = (($Details.msvcInclude) + ';' + ($Details.windowsSdkIncludes -join ';'))
        $env:LIB = (($Details.msvcLib) + ';' + $Details.windowsSdkUcrtLib + ';' + $Details.windowsSdkUmLib)
        # Invoke the exact discovered linker instead of depending on the
        # caller having entered a Visual Studio Developer PowerShell first.
        $env:PATH = ((Split-Path -Parent $Details.cl) + ';' + (Split-Path -Parent $Details.link) + ';' + $oldPath)
        $arguments = @(
            '/nologo',
            '/MD',
            ('/Fo' + $object),
            ('/Fe:' + $executable),
            $source,
            '/link',
            ('/LIBPATH:' + $Details.msvcLib),
            ('/LIBPATH:' + $Details.windowsSdkUcrtLib),
            ('/LIBPATH:' + $Details.windowsSdkUmLib),
            '/SUBSYSTEM:CONSOLE'
        )
        $output = (& $Details.cl @arguments 2>&1 | Out-String).Trim()
        $result.exitCode = $LASTEXITCODE
        $result.output = $output
        $result.ok = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $executable -PathType Leaf))
    }
    catch {
        $result.output = $_.Exception.Message
        $result.exitCode = $null
    }
    finally {
        if ($null -eq $oldInclude) { Remove-Item Env:INCLUDE -ErrorAction SilentlyContinue } else { $env:INCLUDE = $oldInclude }
        if ($null -eq $oldLib) { Remove-Item Env:LIB -ErrorAction SilentlyContinue } else { $env:LIB = $oldLib }
        if ($null -eq $oldPath) { Remove-Item Env:PATH -ErrorAction SilentlyContinue } else { $env:PATH = $oldPath }
        Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $result
}

function Invoke-ResourceCompilerProbe {
    param([Parameter(Mandatory = $true)][string]$Path)

    $result = [ordered]@{
        ok = $false
        source = $null
        resource = $null
        exitCode = $null
        output = $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $result.output = 'rc.exe was not found.'
        return $result
    }
    $probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('life-timeline-rc-probe-' + [guid]::NewGuid().ToString('N'))
    $source = Join-Path $probeRoot 'probe.rc'
    $resource = Join-Path $probeRoot 'probe.res'
    $result.source = $source
    $result.resource = $resource
    try {
        New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
        @'
STRINGTABLE
BEGIN
  1 "life-timeline toolchain probe"
END
'@ | Set-Content -LiteralPath $source -Encoding unicode
        $output = (& $Path '/nologo' '/fo' $resource $source 2>&1 | Out-String).Trim()
        $result.exitCode = $LASTEXITCODE
        $result.output = $output
        $result.ok = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $resource -PathType Leaf))
    }
    catch {
        $result.output = $_.Exception.Message
        $result.exitCode = $null
    }
    finally {
        Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $result
}

$hostIsWindows = ($env:OS -eq 'Windows_NT') -or ($IsWindows -eq $true)
$failures = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}
$hostArchitecture = try {
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
}
catch {
    if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
}

$checks.host = [ordered]@{
    isWindows = $hostIsWindows
    os = [System.Environment]::OSVersion.VersionString
    architecture = $hostArchitecture
}

if (-not $hostIsWindows) {
    $failures.Add('Windows x64 is required for the Tauri NSIS build; this host is not Windows.')
}
elseif ($checks.host.architecture -ne 'X64') {
    $failures.Add("Windows x64 is required for the first release target; detected $($checks.host.architecture).")
}

foreach ($tool in @('node', 'pnpm', 'cargo', 'rustc', 'rustup')) {
    $path = Get-ExecutablePath -Name $tool
    $checks[$tool] = [ordered]@{ path = $path; found = [bool]$path }
    if (-not $path) {
        $failures.Add("Required tool '$tool' was not found on PATH.")
    }
}

$target = 'x86_64-pc-windows-msvc'
$checks.rust = [ordered]@{
    version = $null
}
$checks.rustComponents = [ordered]@{
    fmt = [ordered]@{ found = $false; output = $null }
    clippy = [ordered]@{ found = $false; output = $null }
}
$checks.rustTarget = [ordered]@{ name = $target; installed = $false; output = $null }
if ($checks.rustup.found) {
    $targetResult = Invoke-VersionCommand -Path $checks.rustup.path -Arguments @('target', 'list', '--installed')
    $checks.rustTarget.output = $targetResult.output
    $checks.rustTarget.installed = $targetResult.ok -and (($targetResult.output -split '\r?\n') -contains $target)
    if (-not $checks.rustTarget.installed) {
        $failures.Add("Rust target '$target' is not installed. Run: rustup target add $target")
    }
}
else {
    $failures.Add("Cannot verify Rust target '$target' because rustup is unavailable.")
}

if ($checks.rustc.found) {
    $rustVersion = Invoke-VersionCommand -Path $checks.rustc.path -Arguments @('-vV')
    $checks.rust.version = $rustVersion.output
    if (-not $rustVersion.ok) {
        $failures.Add('rustc -vV failed; the Rust installation is not usable.')
    }
    elseif ($rustVersion.output -notmatch '(?m)^host:\s*x86_64-pc-windows-msvc\s*$') {
        $failures.Add("rustc host is not x86_64-pc-windows-msvc. Output: $($rustVersion.output)")
    }
}

if ($checks.cargo.found) {
    foreach ($component in @('fmt', 'clippy')) {
        $componentResult = Invoke-VersionCommand -Path $checks.cargo.path -Arguments @($component, '--version')
        $checks.rustComponents[$component].found = $componentResult.ok
        $checks.rustComponents[$component].output = $componentResult.output
        if (-not $componentResult.ok) {
            $failures.Add("Cargo component '$component' is unavailable. Install it with rustup component add $component.")
        }
    }
}
else {
    $failures.Add('Cannot verify cargo fmt/clippy because cargo is unavailable.')
}

$checks.msvc = Get-MsvcDetails
$checks.msvc.linkProbe = [ordered]@{
    ok = $false
    mode = '/MD'
    output = 'Not run because cl.exe, link.exe, or the required SDK paths were not found.'
}
$checks.msvc.resourceProbe = [ordered]@{
    ok = $false
    output = 'Not run because rc.exe was not found.'
}
if (-not $checks.msvc.cl) {
    $failures.Add('MSVC cl.exe was not found. Install Microsoft C++ Build Tools with the MSVC x64/x86 component.')
}
if (-not $checks.msvc.link) {
    $failures.Add('MSVC link.exe was not found. Install the MSVC build tools workload.')
}
if (-not $checks.msvc.windowsSdkResourceCompiler) {
    $failures.Add('Windows SDK rc.exe was not found. Install a Windows 10/11 SDK through Visual Studio Installer.')
}
if ($checks.msvc.found) {
    $checks.msvc.linkProbe = Invoke-MsvcLinkProbe -Details $checks.msvc
    $checks.msvc.resourceProbe = Invoke-ResourceCompilerProbe -Path $checks.msvc.windowsSdkResourceCompiler
    if (-not $checks.msvc.linkProbe.ok) {
        $probeMessage = if ($checks.msvc.linkProbe.output) { " Output: $($checks.msvc.linkProbe.output)" } else { '' }
        $failures.Add("MSVC x64 compile/link probe failed; the CRT/Windows SDK libraries are incomplete or not linkable.$probeMessage")
    }
    if (-not $checks.msvc.resourceProbe.ok) {
        $probeMessage = if ($checks.msvc.resourceProbe.output) { " Output: $($checks.msvc.resourceProbe.output)" } else { '' }
        $failures.Add("Windows SDK resource compiler probe failed; rc.exe could not compile a minimal resource.$probeMessage")
    }
}

$checks.tauriCli = [ordered]@{ found = $false; version = $null }
$pnpmPath = $checks.pnpm.path
if ($pnpmPath) {
    $tauriResult = Invoke-VersionCommand -Path $pnpmPath -Arguments @('exec', 'tauri', '--version')
    $checks.tauriCli.found = $tauriResult.ok
    $checks.tauriCli.version = $tauriResult.output
    if (-not $tauriResult.ok) {
        $failures.Add('The local Tauri CLI is unavailable. Install the pinned @tauri-apps/cli dependency before building.')
    }
}

$result = [ordered]@{
    ok = ($failures.Count -eq 0)
    checkedAt = [DateTimeOffset]::Now.ToString('o')
    target = $target
    checks = $checks
    failures = @($failures)
}

if ($Json) {
    $result | ConvertTo-Json -Depth 12
}
else {
    Write-Output "life-timeline Windows toolchain check: $(if ($result.ok) { 'PASS' } else { 'FAIL' })"
    Write-Output "Host: $($checks.host.os) / $($checks.host.architecture)"
    foreach ($name in @('node', 'pnpm', 'cargo', 'rustc', 'rustup')) {
        $entry = $checks[$name]
        Write-Output ("{0}: {1}" -f $name, $(if ($entry.found) { $entry.path } else { 'MISSING' }))
    }
    Write-Output ("Rust target {0}: {1}" -f $target, $(if ($checks.rustTarget.installed) { 'installed' } else { 'MISSING' }))
    $msvcReady = $checks.msvc.found -and $checks.msvc.linkProbe.ok -and $checks.msvc.resourceProbe.ok
    Write-Output ("MSVC: {0}" -f $(if ($msvcReady) { "ready ($($checks.msvc.visualStudio))" } else { 'MISSING or not linkable' }))
    Write-Output ("Tauri CLI: {0}" -f $(if ($checks.tauriCli.found) { $checks.tauriCli.version } else { 'MISSING' }))
    if ($failures.Count -gt 0) {
        Write-Output ''
        Write-Output 'Blocking checks:'
        foreach ($failure in $failures) { Write-Output "- $failure" }
    }
}

if (-not $result.ok) {
    exit 1
}
exit 0
