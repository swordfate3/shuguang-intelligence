# Windows PowerShell 5.1 compatible. Docker Desktop only; no automatic installation.
[CmdletBinding()]
param([string] $Action = 'start')

$script:DawnWindowsRoot = $PSScriptRoot

function Assert-DawnWindowsConfiguration {
    param([object] $Configuration)
    if ($null -eq $Configuration -or $Configuration -is [array] -or $Configuration -is [string]) {
        throw 'Invalid Windows Docker configuration.'
    }
    if ($Configuration -is [System.Collections.IDictionary]) {
        $names = @($Configuration.Keys)
    } else {
        $names = @($Configuration.PSObject.Properties | ForEach-Object { $_.Name })
    }
    if ($names.Count -ne 2 -or -not ($names -ccontains 'dockerContext') -or -not ($names -ccontains 'projectName')) {
        throw 'Invalid Windows Docker configuration.'
    }
    $context = $Configuration.dockerContext
    $project = $Configuration.projectName
    if ($context -isnot [string] -or $project -isnot [string]) {
        throw 'Invalid Windows Docker configuration.'
    }
    if ($context.Length -lt 1 -or $context.Length -gt 128 -or
        $project.Length -lt 1 -or $project.Length -gt 128 -or
        $context -cmatch '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]' -or
        $project -cmatch '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]' -or
        $context -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9_.-]*\z' -or
        $project -cnotmatch '\A[a-z0-9][a-z0-9_-]*\z') {
        throw 'Invalid Windows Docker configuration.'
    }
}

function Read-DawnWindowsConfiguration {
    param([string] $Root = $script:DawnWindowsRoot)
    # Only the two literal JSON string fields are accepted. Escaped/duplicate keys,
    # comments, extra fields and alternate credential/config sources are rejected.
    try {
        $path = Join-Path $Root 'config/docker-windows.json'
        $raw = [System.IO.File]::ReadAllText($path)
        if ($raw.Length -gt 4096 -or $raw -cnotmatch '\A\s*\{\s*"(?<first>dockerContext|projectName)"\s*:\s*"[A-Za-z0-9_.-]+"\s*,\s*"(?<second>dockerContext|projectName)"\s*:\s*"[A-Za-z0-9_.-]+"\s*\}\s*\z') {
            throw 'Invalid configuration.'
        }
        if ($Matches.first -ceq $Matches.second) { throw 'Invalid configuration.' }
        $configuration = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
        Assert-DawnWindowsConfiguration -Configuration $configuration
        return $configuration
    } catch {
        throw 'Cannot read a valid config/docker-windows.json.'
    }
}

function ConvertTo-DawnWindowsArgument {
    param([string] $Value)
    # Windows CommandLineToArgvW quoting, used without cmd.exe or a shell.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-DawnWindowsDocker {
    param([string[]] $Argv, [bool] $Interactive = $false)
    try {
        $docker = Get-Command docker -CommandType Application -ErrorAction Stop | Select-Object -First 1
        if ($Interactive) {
            # No redirected streams: setup sees the real terminal and can hide key entry.
            # Direct pipeline capture (including Out-Host) would break Docker auto-TTY.
            $info = New-Object System.Diagnostics.ProcessStartInfo
            $info.FileName = $docker.Source
            $info.Arguments = (($Argv | ForEach-Object { ConvertTo-DawnWindowsArgument -Value $_ }) -join ' ')
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $false
            $info.RedirectStandardInput = $false
            $info.RedirectStandardOutput = $false
            $info.RedirectStandardError = $false
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $info
            try {
                if (-not $process.Start()) { throw 'Docker process failed.' }
                $process.WaitForExit()
                $code = $process.ExitCode
            } finally {
                $process.Dispose()
            }
            return [pscustomobject]@{ ExitCode = [int] $code; Lines = [string[]] @() }
        }
        # Native stderr is intentionally discarded, never interpolated in failures.
        # PS5 does not implement native-error preference semantics; snapshot explicitly.
        $ErrorActionPreference = 'Continue'
        # Windows PowerShell 5.1 writes native exit status to the global variable.
        # A local LASTEXITCODE would shadow it and turn every success into failure.
        $global:LASTEXITCODE = $null
        $lines = @(& $docker.Source @Argv 2>$null)
        $code = $global:LASTEXITCODE
        if ($null -eq $code) { throw 'Docker process failed.' }
        return [pscustomobject]@{ ExitCode = [int] $code; Lines = [string[]] $lines }
    } catch {
        throw 'Docker command could not be executed. Check Docker Desktop and Docker CLI.'
    }
}

function Invoke-DawnWindowsLauncher {
    [CmdletBinding()]
    param(
        [string] $Action = 'start',
        [string] $Root = $script:DawnWindowsRoot,
        [object] $Configuration,
        [scriptblock] $InvokeDocker = ${function:Invoke-DawnWindowsDocker},
        [object] $IsInteractive = { [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected },
        [scriptblock] $Pause = { param([int] $Seconds) Start-Sleep -Seconds $Seconds }
    )
    if ($Action -ceq 'help') {
        Write-Host 'Dawn - Windows Docker Desktop + DSH'
        Write-Host '.\start.ps1 [start|status|stop|build|help]'
        Write-Host 'start: configure missing files explicitly, start Dawn, then return to DSH.'
        Write-Host 'build: stop the service first; build may download the Node base image.'
        Write-Host 'stop preserves all data volumes. No automatic wake, generation or learning.'
        Write-Host 'Docker Desktop must already be running with Linux containers.'
        return 0
    }
    if (@('start', 'status', 'stop', 'build') -cnotcontains $Action) {
        throw 'Unknown action. Use .\start.ps1 help.'
    }
    Assert-DawnWindowsConfiguration -Configuration $Configuration
    if ([string]::IsNullOrWhiteSpace($Root) -or $Root -cmatch '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]' -or
        $Root -cnotmatch '\A(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))' -or
        -not [System.IO.Path]::IsPathRooted($Root)) {
        throw 'Project root must be an absolute path without control characters.'
    }
    $Root = [System.IO.Path]::GetFullPath($Root)
    $context = $Configuration.dockerContext
    $project = $Configuration.projectName
    $prefix = [string[]] @('--context', $context)
    $compose = [string[]] @('compose', '--project-directory', $Root, '--project-name', $project, '-f', (Join-Path $Root 'compose.yaml'))

    function Invoke-FixedDocker {
        param([string[]] $Tail, [bool] $Interactive = $false)
        # The seam must emit exactly one { ExitCode = int; Lines = string[] } object.
        try { $result = & $InvokeDocker ([string[]] ($prefix + $Tail)) $Interactive }
        catch { throw 'Docker command failed. No underlying output was disclosed.' }
        if ($null -eq $result -or $result -is [array] -or
            $result.ExitCode -isnot [int] -or $null -eq $result.Lines) {
            throw 'Docker command returned an invalid result.'
        }
        foreach ($line in $result.Lines) {
            if ($line -isnot [string]) { throw 'Docker command returned an invalid result.' }
        }
        return $result
    }
    function Assert-FixedSuccess {
        param([object] $Result, [string] $Message)
        if ($Result.ExitCode -ne 0) { throw $Message }
    }
    function Get-FixedLines {
        param([object] $Result)
        return @($Result.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }

    $inspection = Invoke-FixedDocker -Tail @('context', 'inspect', $context, '--format', '{{.Endpoints.docker.Host}}')
    Assert-FixedSuccess $inspection 'Docker context could not be inspected. Start Docker Desktop and check the configured context.'
    $endpoints = @(Get-FixedLines $inspection)
    if ($endpoints.Count -ne 1 -or $endpoints[0] -cnotmatch '\Anpipe:////\./pipe/[A-Za-z0-9_.-]+\z') {
        throw 'Only a local Windows named-pipe Docker context is supported. TCP, SSH and Unix endpoints are refused.'
    }
    $version = Invoke-FixedDocker -Tail @('compose', 'version')
    Assert-FixedSuccess $version 'Docker Compose v2 is unavailable. No installation was attempted.'
    $engine = Invoke-FixedDocker -Tail @('info', '--format', '{{.OSType}}')
    Assert-FixedSuccess $engine 'Docker Desktop is unavailable. Start it yourself; no automatic startup was attempted.'
    $os = @(Get-FixedLines $engine)
    if ($os.Count -ne 1 -or $os[0] -cne 'linux') {
        throw 'Docker Desktop must use Linux containers.'
    }

    if ($Action -ceq 'status') {
        $status = Invoke-FixedDocker -Tail ($compose + @('ps', '-a'))
        Assert-FixedSuccess $status 'Could not query the configured Dawn project.'
        foreach ($line in $status.Lines) { Write-Host $line }
        return 0
    }
    if ($Action -ceq 'stop') {
        $stopped = Invoke-FixedDocker -Tail ($compose + @('stop', 'dawn'))
        Assert-FixedSuccess $stopped 'Could not stop Dawn. No volumes were removed.'
        Write-Host 'Dawn stopped. All existing data volumes were preserved.'
        return 0
    }
    $query = Invoke-FixedDocker -Tail ($compose + @('ps', '--status', 'running', '-q', 'dawn'))
    Assert-FixedSuccess $query 'Could not query the running Dawn service.'
    $running = @(Get-FixedLines $query).Count -gt 0
    if ($Action -ceq 'build') {
        if ($running) { throw 'Dawn is running. Finish DSH requests and stop Dawn before building.' }
        $built = Invoke-FixedDocker -Tail ($compose + @('build', 'dawn')) -Interactive $true
        Assert-FixedSuccess $built 'Dawn image build failed. Existing data was not reset.'
        Write-Host 'Dawn image built. Run .\start.ps1 start to use it; existing subject/configuration will be preserved.'
        return 0
    }
    if (-not $running) {
        if ($IsInteractive -is [scriptblock]) { $terminal = & $IsInteractive }
        elseif ($IsInteractive -is [bool]) { $terminal = $IsInteractive }
        else { throw 'Interactive-terminal check is invalid.' }
        if ($terminal -isnot [bool] -or -not $terminal) {
            throw 'First setup/start requires an interactive terminal. Do not pipe this command.'
        }
        $imagesResult = Invoke-FixedDocker -Tail ($compose + @('config', '--images'))
        Assert-FixedSuccess $imagesResult 'Could not determine the Dawn image.'
        $images = @(Get-FixedLines $imagesResult)
        if ($images.Count -ne 1 -or $images[0] -cmatch '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]' -or $images[0].StartsWith('-')) {
            throw 'The Compose configuration must identify exactly one Dawn image.'
        }
        $image = Invoke-FixedDocker -Tail @('image', 'inspect', $images[0])
        if ($image.ExitCode -ne 0) {
            Write-Host 'Building missing Dawn image. This may download the Node base image.'
            $built = Invoke-FixedDocker -Tail ($compose + @('build', 'dawn')) -Interactive $true
            Assert-FixedSuccess $built 'Dawn image build failed. Existing data was not reset.'
        }
        Write-Host 'Setup target: keep the original engine/project to reuse the existing subject volume.'
        Write-Host ('dockerProjectDir: ' + $Root)
        Write-Host ('dockerContext: ' + $context)
        Write-Host ('dockerProjectName: ' + $project)
        Write-Host 'If this differs from your old deployment, cancel; do not create a replacement subject to fix a connection.'
        $setup = Invoke-FixedDocker -Tail ($compose + @('run', '--rm', '--no-deps', 'dawn', 'setup')) -Interactive $true
        Assert-FixedSuccess $setup 'Dawn setup failed or was cancelled. Existing files were not automatically reset.'
        $started = Invoke-FixedDocker -Tail ($compose + @('up', '-d', '--no-build', 'dawn'))
        Assert-FixedSuccess $started 'Dawn could not start. No subject data was reset.'
    } else {
        Write-Host 'Dawn is already running. Reusing it without setup or rebuilding.'
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $probe = Invoke-FixedDocker -Tail ($compose + @('exec', '-T', 'dawn', 'dawn-container', 'status'))
        if ($probe.ExitCode -eq 0) { $ready = $true; break }
        if ($attempt -lt 4) { $null = & $Pause 1 }
    }
    if (-not $ready) { throw 'Dawn did not become ready. Do not send generation requests or blindly retry messages.' }
    Write-Host 'Dawn is ready. Use the Shuguang Intelligence panel in DSH; query status first.'
    Write-Host 'Use these exact DSH plugin settings (HTTP/token fields remain empty):'
    Write-Host 'connection: docker'
    Write-Host ('dockerProjectDir: ' + $Root)
    Write-Host ('dockerContext: ' + $context)
    Write-Host ('dockerProjectName: ' + $project)
    Write-Host 'No automatic wake, generation or learning. Closing DSH does not stop Dawn.'
    return 0
}

# Dot sourcing exposes functions only: no configuration reads or Docker invocations.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Action -ceq 'help') {
            $null = Invoke-DawnWindowsLauncher -Action help
        } else {
            $configuration = Read-DawnWindowsConfiguration -Root $script:DawnWindowsRoot
            $null = Invoke-DawnWindowsLauncher -Action $Action -Root $script:DawnWindowsRoot -Configuration $configuration
        }
        exit 0
    } catch {
        # Allowlisted diagnostics only: never echo a native exception, argv or stderr.
        $hint = switch -Exact ($_.Exception.Message) {
            'Cannot read a valid config/docker-windows.json.' { 'Invalid or missing config/docker-windows.json.' }
            'Invalid Windows Docker configuration.' { 'Invalid Windows Docker configuration fields.' }
            'Docker command could not be executed. Check Docker Desktop and Docker CLI.' { 'Docker CLI could not be executed.' }
            'Docker command failed. No underlying output was disclosed.' { 'Docker CLI execution failed; check PATH and local permissions.' }
            'Docker command returned an invalid result.' { 'Docker CLI wrapper returned an invalid result.' }
            'Docker context could not be inspected. Start Docker Desktop and check the configured context.' { 'Configured Docker context could not be inspected.' }
            'Only a local Windows named-pipe Docker context is supported. TCP, SSH and Unix endpoints are refused.' { 'Configured Docker context is not a local Windows named pipe.' }
            'Docker Compose v2 is unavailable. No installation was attempted.' { 'Docker Compose v2 is unavailable.' }
            'Docker Desktop is unavailable. Start it yourself; no automatic startup was attempted.' { 'Docker Desktop Linux engine is unreachable. Start Desktop and check local permissions.' }
            'Docker Desktop must use Linux containers.' { 'Docker Desktop is not using Linux containers.' }
            'First setup/start requires an interactive terminal. Do not pipe this command.' { 'An interactive terminal is required. Open Windows PowerShell directly, not a redirected process.' }
            'Dawn setup failed or was cancelled. Existing files were not automatically reset.' { 'Container setup failed or was cancelled; existing files were not reset.' }
            'Dawn did not become ready. Do not send generation requests or blindly retry messages.' { 'Dawn did not become ready. Check container status; do not blindly resend messages.' }
            default { 'Check Windows configuration, Desktop Linux engine, and the original project.' }
        }
        [Console]::Error.WriteLine('Dawn Windows launcher failed. ' + $hint + ' No data was reset; raw errors were not disclosed.')
        exit 1
    }
}
