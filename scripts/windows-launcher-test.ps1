# Offline PowerShell 5.1/7 tests. Fake Docker only; no engine, volumes, models or credentials.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'start.ps1')
$script:Passed = 0
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Equal($Actual, $Expected, [string]$Message) {
    $a = ConvertTo-Json -InputObject $Actual -Compress -Depth 20
    $e = ConvertTo-Json -InputObject $Expected -Compress -Depth 20
    if ($a -cne $e) { throw ($Message + ': actual=' + $a + '; expected=' + $e) }
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:Passed++
    Write-Host "PASS $Name"
}
function New-Fixture {
    $state = [pscustomobject]@{
        Calls = (New-Object 'System.Collections.Generic.List[object]')
        Pauses = (New-Object 'System.Collections.Generic.List[int]')
        Running = $false; Image = $true; SetupFail = $false; ReadyFail = $false
        Engine = 'linux'; Endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine'
        Images = @('synthetic-dawn-image'); Failure = ''; ProbeCount = 0; TtyChecks = 0
    }
    $docker = {
        param([string[]]$Argv, [bool]$Interactive)
        $state.Calls.Add([pscustomobject]@{ Argv = @($Argv); Interactive = $Interactive })
        $lines = @(); $code = 0
        if ($Argv[2] -eq 'context') { $lines = @($state.Endpoint) }
        elseif ($Argv[2] -eq 'info') { $lines = @($state.Engine) }
        elseif ($Argv[2] -eq 'image') { if (-not $state.Image) { $code = 1 } }
        elseif ($Argv[2] -eq 'compose' -and $Argv[3] -ne 'version') {
            $cmd = @($Argv | Select-Object -Skip 9)
            switch ($cmd[0]) {
                'ps' { if ($cmd -contains '--status' -and $state.Running) { $lines = @('synthetic-running') } }
                'config' { $lines = $state.Images }
                'run' { if ($state.SetupFail) { $code = 1 } }
                'exec' { $state.ProbeCount++; if ($state.ReadyFail) { $code = 1 } }
            }
        }
        if ($state.Failure -and ($Argv -contains $state.Failure)) { $code = 1; $lines = @('RAW_SYNTHETIC_SECRET_MUST_NOT_LEAK') }
        [pscustomobject]@{ ExitCode = $code; Lines = [string[]]$lines }
    }.GetNewClosure()
    $pause = { param([int]$Seconds) $state.Pauses.Add($Seconds) }.GetNewClosure()
    $tty = { $state.TtyChecks++; $true }.GetNewClosure()
    [pscustomobject]@{ State = $state; Docker = $docker; Pause = $pause; Tty = $tty }
}
function Run-Fixture($Fixture, [string]$Action = 'start', $Config = $null, $Tty = $null) {
    if ($null -eq $Config) { $Config = [pscustomobject]@{ dockerContext = 'desktop-linux'; projectName = 'shuguang-intelligence' } }
    if ($null -eq $Tty) { $Tty = $Fixture.Tty }
    Invoke-DawnWindowsLauncher -Action $Action -Root $root -Configuration $Config -InvokeDocker $Fixture.Docker -IsInteractive $Tty -Pause $Fixture.Pause
}
function Compose-Calls($Fixture) {
    @($Fixture.State.Calls | Where-Object { $_.Argv[2] -eq 'compose' -and $_.Argv[3] -ne 'version' } | ForEach-Object { ,@($_.Argv | Select-Object -Skip 9) })
}
function Assert-Throws([scriptblock]$Body) {
    $failed = $false
    try { & $Body | Out-Null } catch { $failed = $true; Assert-True ($_.Exception.Message -notmatch 'RAW_SYNTHETIC_SECRET') 'Raw Docker failure leaked' }
    Assert-True $failed 'Expected a failure'
}
Test-Case 'help needs neither config nor Docker' {
    $f = New-Fixture
    Assert-Equal (Run-Fixture $f 'help' ([pscustomobject]@{bad='value'})) 0 'help failed'
    Assert-Equal $f.State.Calls.Count 0 'help touched Docker'
}
Test-Case 'unknown action fails before Docker' {
    $f = New-Fixture
    Assert-Throws { Run-Fixture $f 'invalid' }
    Assert-Equal $f.State.Calls.Count 0 'invalid action touched Docker'
}
Test-Case 'invalid or mixed configuration never reaches Docker' {
    foreach ($config in @(
        [pscustomobject]@{ dockerContext = ''; projectName = 'valid' },
        [pscustomobject]@{ dockerContext = '--host'; projectName = 'valid' },
        [pscustomobject]@{ dockerContext = "default`nremote"; projectName = 'valid' },
        [pscustomobject]@{ dockerContext = ('a' * 129); projectName = 'valid' },
        [pscustomobject]@{ dockerContext = 'default'; projectName = 'Upper' },
        [pscustomobject]@{ dockerContext = 'default'; projectName = 'bad/name' },
        [pscustomobject]@{ dockerContext = 'default'; projectName = '' },
        [pscustomobject]@{ dockerContext = 'default'; projectName = ('a' * 129) },
        [pscustomobject]@{ dockerContext = 'default'; projectName = 'valid'; endpoint = 'tcp://remote' },
        [pscustomobject]@{ dockerContext = 123; projectName = 'valid' },
        [pscustomobject]@{ DockerContext = 'default'; projectName = 'valid' }
    )) {
        $f = New-Fixture; Assert-Throws { Run-Fixture $f 'status' $config }
        Assert-Equal $f.State.Calls.Count 0 'invalid config touched Docker'
    }
}
Test-Case 'remote TCP SSH Unix or malformed endpoints are refused' {
    foreach ($endpoint in @('tcp://127.0.0.1:2375','ssh://host','unix:///var/run/docker.sock','npipe://remote/pipe/docker','npipe:////remote/pipe/docker','')) {
        $f = New-Fixture; $f.State.Endpoint = $endpoint
        Assert-Throws { Run-Fixture $f 'status' }
        Assert-True (-not ($f.State.Calls | Where-Object { $_.Argv -contains 'ps' })) 'remote endpoint reached Compose'
    }
}
Test-Case 'non Linux or inaccessible engine fails without setup or up' {
    $f = New-Fixture; $f.State.Engine = 'windows'; Assert-Throws { Run-Fixture $f }
    $g = New-Fixture; $g.State.Failure = 'info'; Assert-Throws { Run-Fixture $g }
    foreach ($fixture in @($f,$g)) { Assert-Equal @(Compose-Calls $fixture).Count 0 'engine failure touched workload' }
}
Test-Case 'status uses explicit context root project compose without mutation' {
    $f = New-Fixture; Assert-Equal (Run-Fixture $f 'status') 0 'status failed'
    Assert-Equal @(Compose-Calls $f) @(,@('ps','-a')) 'status had extra commands'
    foreach ($call in $f.State.Calls) { Assert-Equal @($call.Argv | Select-Object -First 2) @('--context','desktop-linux') 'context not fixed' }
    $call = @($f.State.Calls | Where-Object { $_.Argv -contains 'ps' })[0]
    Assert-Equal @($call.Argv | Select-Object -First 9) @('--context','desktop-linux','compose','--project-directory',$root,'--project-name','shuguang-intelligence','-f',(Join-Path $root 'compose.yaml')) 'compose target mismatch'
}
Test-Case 'stop preserves volumes and performs only normal stop' {
    $f = New-Fixture; Assert-Equal (Run-Fixture $f 'stop') 0 'stop failed'
    Assert-Equal @(Compose-Calls $f) @(,@('stop','dawn')) 'stop changed data'
}
Test-Case 'explicit build refuses running service and builds stopped service only' {
    $f = New-Fixture; $f.State.Running = $true; Assert-Throws { Run-Fixture $f 'build' }
    Assert-Equal @(Compose-Calls $f).Count 1 'running build did more than inspect'
    $g = New-Fixture; Assert-Equal (Run-Fixture $g 'build') 0 'build failed'
    Assert-Equal @(Compose-Calls $g) @(@('ps','--status','running','-q','dawn'),@('build','dawn')) 'build created a service'
}
Test-Case 'first start builds missing image then setup up readiness with no client exec' {
    $f = New-Fixture; $f.State.Image = $false
    Assert-Equal (Run-Fixture $f) 0 'start failed'
    Assert-Equal @(Compose-Calls $f) @(
        @('ps','--status','running','-q','dawn'),@('config','--images'),@('build','dawn'),
        @('run','--rm','--no-deps','dawn','setup'),@('up','-d','--no-build','dawn'),@('exec','-T','dawn','dawn-container','status')
    ) 'startup order wrong'
    $setup = @($f.State.Calls | Where-Object { $_.Argv -contains 'setup' })[0]
    Assert-True $setup.Interactive 'setup cannot inherit terminal'
    Assert-Equal $f.State.TtyChecks 1 'TTY not checked'
}
Test-Case 'existing image is reused and setup failure prevents up or readiness' {
    $f = New-Fixture; $f.State.SetupFail = $true; Assert-Throws { Run-Fixture $f }
    Assert-True (-not ($f.State.Calls | Where-Object { $_.Argv -contains 'up' -or $_.Argv -contains 'exec' -or $_.Argv -contains 'build' })) 'setup failure continued'
}
Test-Case 'stopped start refuses redirected terminal before build setup or up' {
    $f = New-Fixture; Assert-Throws { Run-Fixture $f 'start' $null $false }
    Assert-Equal @(Compose-Calls $f).Count 1 'nonTTY started workload'
}
Test-Case 'running service bypasses terminal setup image lookup build and up' {
    $f = New-Fixture; $f.State.Running = $true
    Assert-Equal (Run-Fixture $f 'start' $null $false) 0 'running reuse failed'
    Assert-Equal @(Compose-Calls $f) @(@('ps','--status','running','-q','dawn'),@('exec','-T','dawn','dawn-container','status')) 'running service altered'
    Assert-Equal $f.State.TtyChecks 0 'running service needs terminal'
}
Test-Case 'readiness failure is bounded five probes four pauses without auto generation' {
    $f = New-Fixture; $f.State.Running = $true; $f.State.ReadyFail = $true
    Assert-Throws { Run-Fixture $f }
    Assert-Equal $f.State.ProbeCount 5 'readiness not bounded'
    Assert-Equal $f.State.Pauses.Count 4 'pause count wrong'
    foreach ($call in @(Compose-Calls $f)) { Assert-True (@('ps','exec') -contains $call[0]) 'readiness launched other work' }
}
Test-Case 'multiple or empty image names fail before build or setup' {
    foreach ($images in @(@('first','second'),@(''))) {
        $f = New-Fixture; $f.State.Images = $images; Assert-Throws { Run-Fixture $f }
        Assert-True (-not ($f.State.Calls | Where-Object { $_.Argv -contains 'run' -or $_.Argv -contains 'build' -or $_.Argv -contains 'up' })) 'invalid image allowed startup'
    }
}
Test-Case 'build up compose-version and context-inspect failures stop immediately' {
    foreach ($target in @('build','up','version','inspect')) {
        $f = New-Fixture; $f.State.Failure = $target
        if ($target -eq 'build') { $f.State.Image = $false }
        Assert-Throws { Run-Fixture $f }
        Assert-Equal $f.State.ProbeCount 0 'failure still checked started service'
    }
}
Test-Case 'alternate safe context and original project remain exact argv' {
    $f = New-Fixture
    Assert-Equal (Run-Fixture $f 'status' ([pscustomobject]@{dockerContext='desktop-local';projectName='original_subject-1'})) 0 'alternate config failed'
    foreach ($call in $f.State.Calls) { Assert-Equal @($call.Argv | Select-Object -First 2) @('--context','desktop-local') 'context changed' }
    $psCall = @($f.State.Calls | Where-Object { $_.Argv -contains 'ps' })[0]
    Assert-Equal $psCall.Argv[6] 'original_subject-1' 'project not preserved'
}
Test-Case 'checked-in JSON config loads and has exact plugin-compatible settings' {
    $config = Read-DawnWindowsConfiguration -Root $root
    Assert-Equal $config.dockerContext 'desktop-linux' 'wrong Windows context default'
    Assert-Equal $config.projectName 'shuguang-intelligence' 'wrong original project default'
}
Test-Case 'file loader rejects malformed duplicate escaped unknown and oversized JSON' {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('dawn-win-config-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path (Join-Path $temp 'config') -Force
    try {
        $configPath = Join-Path $temp 'config/docker-windows.json'
        Assert-Throws { Read-DawnWindowsConfiguration -Root $temp }
        foreach ($raw in @(
            '{"dockerContext":"default","dockerContext":"default"}',
            '{"dockerContext":"default","projectName":"valid","token":"synthetic"}',
            '{"dockerContext":"default","projectName":"Upper"}',
            '{"dockerContext":"default","projectName":"valid",}',
            '{"dockerContext":"default","projectName":"\\u0076alid"}',
            '[]', 'not-json', (' ' * 4097)
        )) {
            [System.IO.File]::WriteAllText($configPath, $raw)
            Assert-Throws { Read-DawnWindowsConfiguration -Root $temp }
        }
        [System.IO.File]::WriteAllText($configPath, '{"projectName":"original_1","dockerContext":"desktop-local"}')
        Assert-Equal (Read-DawnWindowsConfiguration -Root $temp).projectName 'original_1' 'reverse key order failed'
    } finally {
        $resolved = [System.IO.Path]::GetFullPath($temp)
        Assert-True ($resolved -eq $temp -and (Split-Path -Leaf $temp) -match '^dawn-win-config-[a-f0-9]{32}$') 'unsafe cleanup target'
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
Test-Case 'Windows argv quotes spaces embedded quotes empty and trailing backslash' {
    Assert-Equal (ConvertTo-DawnWindowsArgument '') '""' 'empty argument wrong'
    Assert-Equal (ConvertTo-DawnWindowsArgument 'C:\repo with spaces') '"C:\repo with spaces"' 'spaces not quoted'
    Assert-Equal (ConvertTo-DawnWindowsArgument 'a"b') '"a\"b"' 'embedded quote wrong'
    Assert-Equal (ConvertTo-DawnWindowsArgument 'C:\repo\') '"C:\repo\\"' 'trailing slash wrong'
    Assert-Equal (ConvertTo-DawnWindowsArgument 'a\"b') '"a\\\"b"' 'slash before quote wrong'
}
Test-Case 'project path with spaces remains a single argument and relative paths are refused' {
    $f = New-Fixture
    $spaceRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'synthetic project with spaces'
    Assert-Equal (Invoke-DawnWindowsLauncher -Action status -Root $spaceRoot -Configuration ([pscustomobject]@{dockerContext='desktop-linux';projectName='original'}) -InvokeDocker $f.Docker) 0 'spaced root failed'
    $call = @($f.State.Calls | Where-Object { $_.Argv -contains 'ps' })[0]
    Assert-Equal $call.Argv[4] $spaceRoot 'spaced root split'
    foreach ($badRoot in @('relative','C:relative','\relative',"C:\bad`npath")) {
        $g = New-Fixture
        Assert-Throws { Invoke-DawnWindowsLauncher -Action status -Root $badRoot -Configuration ([pscustomobject]@{dockerContext='desktop-linux';projectName='original'}) -InvokeDocker $g.Docker }
        Assert-Equal $g.State.Calls.Count 0 'bad path reached Docker'
    }
}
Test-Case 'real native capture reads global exit status and never returns stderr' {
    # Resolve the Docker command to a harmless local PowerShell executable in this
    # test scope only. Exercise the actual native wrapper, not the fake Docker seam.
    function Get-Command {
        param($Name, $CommandType, $ErrorAction)
        if ($Name -cne 'docker') { throw 'Unexpected executable lookup' }
        [pscustomobject]@{ Source = (Join-Path $PSHOME 'powershell.exe') }
    }
    $r = Invoke-DawnWindowsDocker -Argv @('-NoProfile','-Command',"[Console]::Out.WriteLine('synthetic-native-ok'); [Console]::Error.WriteLine('RAW_SYNTHETIC_SECRET_MUST_NOT_LEAK'); exit 0")
    Assert-Equal $r.ExitCode 0 'native success was hidden by local exit variable'
    Assert-Equal @($r.Lines) @('synthetic-native-ok') 'native stderr leaked or stdout missing'
    $r = Invoke-DawnWindowsDocker -Argv @('-NoProfile','-Command',"[Console]::Out.WriteLine('synthetic-native-failure'); exit 7")
    Assert-Equal $r.ExitCode 7 'native failure treated as success'
    Assert-Equal @($r.Lines) @('synthetic-native-failure') 'native stdout wrong'
}
Test-Case 'real inherited-stream process waits and returns nonzero without shell' {
    function Get-Command {
        param($Name, $CommandType, $ErrorAction)
        if ($Name -cne 'docker') { throw 'Unexpected executable lookup' }
        [pscustomobject]@{ Source = (Join-Path $PSHOME 'powershell.exe') }
    }
    $r = Invoke-DawnWindowsDocker -Interactive $true -Argv @('-NoProfile','-Command','exit 9')
    Assert-Equal $r.ExitCode 9 'inherited native exit lost'
    Assert-Equal @($r.Lines).Count 0 'inherited process returned unexpected captured output'
}
Write-Host "Windows launcher tests: $script:Passed passed. Fake Docker plus harmless local native processes; no real Docker invoked."
