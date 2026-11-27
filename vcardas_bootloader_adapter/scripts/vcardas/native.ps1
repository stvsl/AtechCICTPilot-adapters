param(
    [ValidateSet('guard', 'preparePacking', 'load', 'pack', 'find', 'process', 'collect', 'waitExit')]
    [string] $Action,
    [string] $RequestFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:FlashRoot = 'D:\KUNYI_flash'

function Assert-PlainPath([string] $Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "拒绝通过符号链接或目录联接访问文件：$current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $full
}

function Join-SafePath([string] $Root, [string] $Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or
            $Relative -match '(^|[\\/])\.\.?([\\/]|$)' -or $Relative.Contains(':')) {
        throw "无效的相对路径：$Relative"
    }
    $base = (Assert-PlainPath $Root).TrimEnd('\')
    $path = Assert-PlainPath ([IO.Path]::Combine($base, $Relative))
    if (-not $path.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "路径超出目标目录：$Relative"
    }
    return $path
}

function Get-TargetPath([string] $Name) {
    if ($Name -notmatch '^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$') {
        throw "无效的目标名称：$Name"
    }
    return Join-SafePath $script:FlashRoot $Name
}

function Get-TreeFiles([string] $Root) {
    $null = Assert-PlainPath $Root
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        $null = Assert-PlainPath $item.FullName
        if ($item.PSIsContainer) {
            Get-TreeFiles $item.FullName
        } else {
            $item
        }
    }
}

function Copy-Tree([string] $Source, [string] $Destination) {
    $sourceRoot = (Assert-PlainPath $Source).TrimEnd('\')
    $null = Assert-PlainPath $Destination
    $null = [IO.Directory]::CreateDirectory($Destination)
    foreach ($item in Get-ChildItem -LiteralPath $sourceRoot -Force) {
        $path = Join-SafePath $Destination $item.Name
        $null = Assert-PlainPath $item.FullName
        if ($item.PSIsContainer) {
            Copy-Tree $item.FullName $path
        } else {
            [IO.File]::Copy($item.FullName, $path, $true)
        }
    }
}

function Write-JsonFile([string] $Path, $Value) {
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -Depth 30 -InputObject $Value),
        [Text.UTF8Encoding]::new($false))
}

function Read-Ini([string] $Path) {
    $values = @{}
    $section = ''
    foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::Default)) {
        if ($line -match '^\s*\[([^\]]+)\]\s*$') {
            $section = $matches[1].ToLowerInvariant()
        } elseif ($line -match '^\s*([^;#=]+?)\s*=\s*(.*?)\s*$') {
            $values[$section + '.' + $matches[1].ToLowerInvariant()] = $matches[2]
        }
    }
    return $values
}

function Get-Signature([string] $Path, [bool] $TextOnly = $false) {
    $bytes = [IO.File]::ReadAllBytes((Assert-PlainPath $Path))
    $binary = $false
    foreach ($value in $bytes) {
        if ($value -lt 9 -or ($value -gt 13 -and $value -lt 32) -or $value -gt 126) {
            $binary = $true
            break
        }
    }
    if ($binary -and -not $TextOnly) {
        if ($bytes.Length -ne 512) { throw "签名不是 512 字节：$Path" }
        return [Convert]::ToBase64String($bytes)
    }
    $content = [Text.Encoding]::ASCII.GetString($bytes)
    $hex = [regex]::Matches($content, '(?i)0x([0-9a-f]{2})')
    if ($hex.Count -lt 8) {
        $hex = [regex]::Matches(($content -replace '[^0-9A-Fa-f]', ''), '([0-9A-Fa-f]{2})')
    }
    if ($hex.Count -ne 512) { throw "签名文本不是 512 字节：$Path" }
    $values = [byte[]]::new(512)
    for ($index = 0; $index -lt 512; ++$index) {
        $values[$index] = [Convert]::ToByte($hex[$index].Groups[1].Value, 16)
    }
    return [Convert]::ToBase64String($values)
}

function Get-Hash([string] $Path) {
    return (Get-FileHash -LiteralPath (Assert-PlainPath $Path) -Algorithm SHA256).Hash
}

function Prepare-PackingInputs($Request) {
    # 先验证所有目标，再替换工程工作副本中的固件输入。
    foreach ($target in $Request.targets) {
        $profile = Read-Ini (Join-SafePath $target.source 'profile.ini')
        foreach ($key in @('driver.file', 'app.file', 'signature.fld', 'signature.app')) {
            if (-not $profile.ContainsKey($key) -or -not $profile[$key]) {
                throw "$($target.name) 的 profile.ini 缺少 $key"
            }
        }
        foreach ($key in @('driver.file', 'app.file')) {
            $null = Join-SafePath $target.source $profile[$key]
        }
        if ($profile['driver.file'] -ieq $profile['app.file']) {
            throw "$($target.name) 的 App 与 Driver 不能使用同一个产物路径"
        }
        foreach ($group in @($target.app, $target.driver)) {
            foreach ($name in @($group.imageName, $group.signatureName)) {
                if ($name -match '[\x00-\x1f''"&|^%!<>\\/:]' -or
                        [IO.Path]::GetFileName($name) -ne $name) {
                    throw "文件名不能安全传给工程 CMD：$name"
                }
            }
            $null = Assert-PlainPath $group.imagePath
            if (-not (Test-Path -LiteralPath $group.imagePath -PathType Leaf)) {
                throw "固件源文件不存在：$($group.imagePath)"
            }
            if ((Get-Item -LiteralPath $group.imagePath).Length -eq 0) {
                throw "固件源文件为空：$($group.imagePath)"
            }
            $null = Get-Signature $group.signaturePath
        }
    }
    foreach ($target in $Request.targets) {
        $directory = Assert-PlainPath $target.source
        $receipt = @{name = $target.name}
        foreach ($role in @('app', 'driver')) {
            $group = $target.$role
            $folder = if ($role -eq 'app') { 'APP' } else { 'Flashdriver' }
            $inbox = Join-SafePath $directory $folder
            $null = [IO.Directory]::CreateDirectory($inbox)
            foreach ($old in Get-ChildItem -LiteralPath $inbox -File) {
                if ($old.Extension -match '^\.(hex|cbf|rsa)$') {
                    Remove-Item -LiteralPath (Assert-PlainPath $old.FullName) -Force
                }
            }
            [IO.File]::Copy($group.imagePath, (Join-SafePath $inbox $group.imageName), $true)
            [IO.File]::Copy($group.signaturePath, (Join-SafePath $inbox $group.signatureName), $true)
            $receipt[$role] = @{
                imageName = $group.imageName; signatureName = $group.signatureName
                imageHash = Get-Hash $group.imagePath
                signature = Get-Signature $group.signaturePath
            }
        }
        Write-JsonFile (Join-SafePath $directory '.atech-inputs.json') $receipt
    }
    return @{prepared = @($Request.targets | ForEach-Object { $_.name })}
}

function Test-PackedOutputs([string] $Directory, [DateTime] $StartedAt) {
    $receipt = Get-Content -LiteralPath (Join-SafePath $Directory '.atech-inputs.json') -Raw -Encoding UTF8 |
        ConvertFrom-Json
    $profile = Read-Ini (Join-SafePath $Directory 'profile.ini')
    foreach ($key in @('driver.file', 'app.file', 'signature.fld', 'signature.app')) {
        if (-not $profile.ContainsKey($key) -or -not $profile[$key]) {
            throw "profile.ini 缺少 $key"
        }
    }
    $outputs = @('profile.ini', 'profile.txt', 'app_src.txt')
    foreach ($key in @('driver.file', 'app.file')) {
        $image = Join-SafePath $Directory $profile[$key]
        $mirror = [IO.Path]::ChangeExtension($image, '.txt')
        if ((Get-Hash $image) -ne (Get-Hash $mirror)) { throw "镜像与 HEX 不一致：$mirror" }
        $outputs += @($profile[$key], [IO.Path]::ChangeExtension($profile[$key], '.txt'))
    }
    $driverPath = Join-SafePath $Directory $profile['driver.file']
    if ((Get-Hash $driverPath) -ne $receipt.driver.imageHash) {
        throw '打包使用的 Driver 不是本次输入'
    }
    $appPath = Join-SafePath $Directory $profile['app.file']
    if ([IO.Path]::GetExtension($receipt.app.imageName) -ieq '.hex' -and
            (Get-Hash $appPath) -ne $receipt.app.imageHash) {
        throw '打包使用的 App 不是本次输入'
    }
    $expectedSource = $receipt.app.imageName
    if ([IO.Path]::GetExtension($expectedSource) -ieq '.cbf') {
        $expectedSource = [IO.Path]::ChangeExtension($expectedSource, '.hex')
        if ($expectedSource -ieq 'app.hex') { $expectedSource = 'app_cbf.hex' }
    }
    if ([IO.File]::ReadAllText((Join-SafePath $Directory 'app_src.txt')).Trim() -ine $expectedSource) {
        throw 'app_src.txt 未指向本次 App 输入'
    }
    foreach ($pair in @(@('fld', 'driver', 'Flashdriver'), @('app', 'app', 'APP'))) {
        $role = $pair[1]
        $relative = $pair[2] + '\' + $receipt.$role.signatureName
        if ($profile['signature.' + $pair[0]] -ine $relative) {
            throw "profile.ini 未引用本次 $role 签名"
        }
        $mirror = [IO.Path]::ChangeExtension($relative, '.txt')
        if ((Get-Signature (Join-SafePath $Directory $mirror) $true) -ne $receipt.$role.signature) {
            throw "$role 签名镜像与本次输入不一致"
        }
        $signaturePath = Join-SafePath $Directory $relative
        if ((Get-Signature $signaturePath) -ne $receipt.$role.signature) {
            throw "$role 签名与本次输入不一致"
        }
        $outputs += @($relative, $mirror)
    }
    if ((Get-Hash (Join-SafePath $Directory 'profile.ini')) -ne
            (Get-Hash (Join-SafePath $Directory 'profile.txt'))) {
        throw 'profile.txt 与 profile.ini 不一致'
    }
    foreach ($relative in $outputs) {
        $item = Get-Item -LiteralPath (Join-SafePath $Directory $relative)
        if ($item.Length -eq 0) {
            throw "打包产物为空：$relative"
        }
    }
    # move/copy 会保留源文件时间戳；HEX 按内容验证，不能把正常的旧时间戳误判为旧输入。
    foreach ($role in @('app', 'driver')) {
        $folder = if ($role -eq 'app') { 'APP' } else { 'Flashdriver' }
        $inbox = Join-SafePath $Directory ($folder + '\' + $receipt.$role.imageName)
        if (Test-Path -LiteralPath $inbox) { throw "打包未消费本次 $role 输入" }
    }
    if ([IO.Path]::GetExtension($receipt.app.imageName) -ieq '.cbf') {
        $archived = Join-SafePath $Directory ('_old\' + $receipt.app.imageName)
        if ((Get-Hash $archived) -ne $receipt.app.imageHash -or
                (Get-Item -LiteralPath $appPath).LastWriteTimeUtc -lt $StartedAt.AddSeconds(-2)) {
            throw 'CBF 本次转换或原始输入归档校验失败'
        }
    }
    $appText = [IO.Path]::ChangeExtension($appPath, '.txt')
    if ((Get-Item -LiteralPath $appText).Length -gt 1MB) {
        $splitRoot = Join-SafePath $Directory 'split'
        $parts = @(Get-ChildItem -LiteralPath $splitRoot -Filter 'app_*.txt' -File | Sort-Object Name)
        if ($parts.Count -eq 0) { throw '大于 1 MB 的 App 没有生成 split 分片' }
        $lines = [Collections.Generic.List[string]]::new()
        foreach ($part in $parts) {
            $null = Assert-PlainPath $part.FullName
            $lines.AddRange([IO.File]::ReadAllLines($part.FullName))
            $outputs += ('split\' + $part.Name)
        }
        if (($lines -join "`n") -cne ([IO.File]::ReadAllLines($appText) -join "`n")) {
            throw 'split 分片与当前 App 不一致或残留旧分片'
        }
    }
    return @{verified = $true; outputs = $outputs}
}

function Invoke-Pack($Request) {
    $command = Assert-PlainPath $Request.command
    if ([IO.Path]::GetFileName($command) -ine 'put_pkg.cmd' -or
            -not (Test-Path -LiteralPath $command -PathType Leaf)) {
        throw '工程目标目录缺少 put_pkg.cmd'
    }
    $directory = [IO.Path]::GetDirectoryName($command)
    $output = Assert-PlainPath $Request.output
    $null = [IO.Directory]::CreateDirectory($output)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = [IO.Path]::Combine($env:SystemRoot, 'System32\cmd.exe')
    $process.StartInfo.Arguments = '/d /c .\put_pkg.cmd'
    $process.StartInfo.WorkingDirectory = $directory
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $stdout = [IO.File]::Create((Join-SafePath $output 'stdout.log'))
    $stderr = [IO.File]::Create((Join-SafePath $output 'stderr.log'))
    $processStarted = $false
    try {
        $started = [DateTime]::UtcNow
        $null = $process.Start()
        $processStarted = $true
        $process.StandardInput.Close()
        $copyOut = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $copyErr = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (-not $process.WaitForExit(300000)) { throw 'put_pkg.cmd 执行超过 300 秒' }
        $null = $copyOut.GetAwaiter().GetResult()
        $null = $copyErr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "put_pkg.cmd 退出码：$($process.ExitCode)" }
        $result = Test-PackedOutputs $directory $started
        Write-JsonFile (Join-SafePath $output 'verification.json') $result
        return $result
    } finally {
        if ($processStarted -and -not $process.HasExited) { $process.Kill() }
        $stdout.Dispose()
        $stderr.Dispose()
        $process.Dispose()
    }
}

function Load-Targets($Request) {
    # CAPL 从固定目录读取数据。只发布本轮已校验的打包产物。
    foreach ($target in $Request.targets) {
        $destination = Get-TargetPath $target.name
        foreach ($relative in $target.outputs) {
            $source = Join-SafePath $target.source $relative
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
                throw "已校验的工程打包产物不存在：$source"
            }
            $null = Join-SafePath $destination $relative
        }
        $split = Join-SafePath $destination 'split'
        if (Test-Path -LiteralPath $split -PathType Container) {
            foreach ($old in Get-ChildItem -LiteralPath $split -Filter 'app_*.txt' -File -Force) {
                $relative = 'split\' + $old.Name
                if ($target.outputs -notcontains $relative) {
                    Remove-Item -LiteralPath (Join-SafePath $destination $relative) -Force
                }
            }
        }
        foreach ($relative in $target.outputs) {
            $source = Join-SafePath $target.source $relative
            $file = Join-SafePath $destination $relative
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
            [IO.File]::Copy($source, $file, $true)
        }
    }
    return @{loaded = @($Request.targets | ForEach-Object { $_.name })}
}

function Get-ProcessIdentity([int] $ProcessId, [bool] $RequireEmpty = $false) {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $result = @{pid = $process.Id; path = $process.Path
        startedAt = $process.StartTime.ToUniversalTime().Ticks.ToString()}
    if (-not $result.path) { throw "无法读取进程 $ProcessId 的程序路径" }
    if ($RequireEmpty) {
        # Ready 和空配置树均不能证明旧工程已关闭；只读检查工程关闭命令的可用状态。
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $process.Refresh()
        if ($process.MainWindowHandle -eq 0) { throw '无法读取主窗口，不能确认旧工程已关闭' }
        $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.Condition]::TrueCondition)
        $close = @()
        $open = @()
        $startPage = @()
        foreach ($element in $elements) {
            $state = $element.Current
            if ($state.AutomationId -match '^CloseProject(Command)?$' -or
                    $state.Name -match '^(关闭工程|关闭项目|Close [Pp]roject)$') {
                $close += @{name = $state.Name; enabled = $state.IsEnabled
                    offscreen = $state.IsOffscreen}
            }
            if ($state.AutomationId -match '^OpenProject(Command)?$' -or
                    $state.Name -match '^(打开工程|打开项目|Open [Pp]roject)$') {
                $open += @{name = $state.Name; enabled = $state.IsEnabled
                    offscreen = $state.IsOffscreen}
            }
            # 当前版本的空窗口显示启动页，不创建工程菜单命令；该图像只在启动页可见。
            if ($state.AutomationId -eq 'openProjectImage') {
                $startPage += @{name = $state.Name; enabled = $state.IsEnabled
                    offscreen = $state.IsOffscreen}
            }
        }
        $menuEvidence = $close.Count -gt 0 -and
            @($close | Where-Object { $_.enabled }).Count -eq 0 -and
            @($open | Where-Object { $_.enabled }).Count -gt 0
        $startPageEvidence = @($startPage | Where-Object {
            $_.enabled -and -not $_.offscreen
        }).Count -gt 0 -and @($close | Where-Object {
            $_.enabled -and -not $_.offscreen
        }).Count -eq 0
        $result.emptyProject = $menuEvidence -or $startPageEvidence
        $result.evidence = @{closeProject = $close; openProject = $open
            startPage = $startPage; mode = if ($menuEvidence) { 'menu' }
                elseif ($startPageEvidence) { 'startPage' } else { 'none' }}
        if (-not $result.emptyProject) {
            throw '检测到旧工程或无法确认窗口为空；请手动关闭旧工程，并保持空白启动页或工程菜单可访问后重试'
        }
    }
    return $result
}

function Copy-Report($Request) {
    $source = Assert-PlainPath $Request.source
    $output = Assert-PlainPath $Request.output
    $item = Get-Item -LiteralPath $source
    $sources = @($item)
    if (-not $item.PSIsContainer) {
        $parent = [IO.Path]::GetDirectoryName($source)
        foreach ($name in @(($item.BaseName + '_files'), 'assets', 'css', 'js', 'images', 'Data')) {
            $candidate = Join-SafePath $parent $name
            if (Test-Path -LiteralPath $candidate -PathType Container) {
                $sources += Get-Item -LiteralPath $candidate
            }
        }
    }
    $files = @($sources | ForEach-Object {
        if ($_.PSIsContainer) { Get-TreeFiles $_.FullName } else { $_ }
    })
    $total = ($files | Measure-Object -Property Length -Sum).Sum
    if ($files.Count -gt 5000 -or $total -gt 256MB) { throw '报告超过 5000 文件或 256 MB 限额' }
    $null = [IO.Directory]::CreateDirectory($output)
    foreach ($part in $sources) {
        $destination = Join-SafePath $output $part.Name
        if ($part.PSIsContainer) { Copy-Tree $part.FullName $destination }
        else { [IO.File]::Copy($part.FullName, $destination, $true) }
    }
    return @{files = $files.Count; bytes = $total}
}

function Invoke-NativeAction([string] $Name, $Request) {
    switch ($Name) {
        'guard' {
            $mutex = [Threading.Mutex]::new($false, 'Global\AtechCICTPilot.VCarDASBootloader')
            $acquired = $false
            try {
                try { $acquired = $mutex.WaitOne(0) }
                catch [Threading.AbandonedMutexException] { $acquired = $true }
                if (-not $acquired) { throw '另一个任务正在使用固定刷写目录' }
                Write-JsonFile $Request.readyPath @{locked = $true}
                while ($true) { Start-Sleep -Milliseconds 250 }
            } finally {
                if ($acquired) { $mutex.ReleaseMutex() }
                $mutex.Dispose()
            }
        }
        'preparePacking' { return Prepare-PackingInputs $Request }
        'load' { return Load-Targets $Request }
        'pack' { return Invoke-Pack $Request }
        'process' { return Get-ProcessIdentity $Request.processId $Request.requireEmpty }
        'find' {
            $name = [IO.Path]::GetFileNameWithoutExtension($Request.executable)
            return ,@(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
                Get-ProcessIdentity $_.Id
            })
        }
        'collect' { return Copy-Report $Request }
        'waitExit' {
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            do {
                $process = Get-Process -Id $Request.processId -ErrorAction SilentlyContinue
                if (-not $process -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Request.startedAt) {
                    return @{exited = $true}
                }
                Start-Sleep -Milliseconds 100
            } while ([DateTime]::UtcNow -lt $deadline)
            throw '请求退出后工具进程仍未结束'
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $result = Invoke-NativeAction $Action $request
        ConvertTo-Json -Depth 30 -Compress -InputObject $result
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
