# Thyra installer for Windows 10 1809+ and Windows 11 (x64 and ARM64).
#
#   irm https://github.com/Yubo-Cao/thyra/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/Yubo-Cao/thyra/releases/latest/download/install.ps1))) -Uninstall
#
# Installs Thyra into %LOCALAPPDATA%\Programs\Thyra and the Herdr build pinned
# by that Thyra release into %APPDATA%\thyra\herdr\<tag>, verifies SHA-256
# checksums, and starts both as per-user scheduled tasks. No administrator
# rights are needed. Re-running upgrades in place. Options may also be set
# through THYRA_* environment variables when piping into iex.
param(
    [string]$Version = $env:THYRA_VERSION,
    [string]$Port = $env:THYRA_PORT,
    [switch]$Lan,
    [switch]$NoService,
    [switch]$NoHerdr,
    [switch]$ReplaceHerdr,
    [switch]$Uninstall,
    [switch]$Purge
)

$ThyraRepository = "Yubo-Cao/thyra"

# ---------------------------------------------------------------------------
# Pure helpers. Tests dot-source this file with THYRA_INSTALLER_LIBRARY=1.

function Get-ThyraPlatform([string]$Architecture) {
    switch ($Architecture) {
        "X64" { return "windows-x64" }
        "Arm64" { return "windows-arm64" }
        default { throw "Unsupported Windows architecture: $Architecture. Thyra supports x64 and ARM64." }
    }
}

function Get-OSArchitecture {
    try {
        return [System.Runtime.InteropServices.RuntimeInformation, mscorlib]::OSArchitecture.ToString()
    } catch {
        $native = $env:PROCESSOR_ARCHITEW6432
        if (-not $native) { $native = $env:PROCESSOR_ARCHITECTURE }
        switch ($native) {
            "AMD64" { return "X64" }
            "ARM64" { return "Arm64" }
            default { return [string]$native }
        }
    }
}

function Get-ReleaseBase([string]$Custom, [string]$RequestedVersion) {
    if ($Custom) {
        $base = $Custom
    } elseif ($RequestedVersion) {
        $base = "https://github.com/$ThyraRepository/releases/download/v$RequestedVersion"
    } else {
        $base = "https://github.com/$ThyraRepository/releases/latest/download"
    }
    return $base.TrimEnd("/")
}

# Accept HTTPS, or HTTP only on loopback, and never credentials or queries.
function Assert-DownloadUrl([string]$Url) {
    $uri = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
        throw "Invalid URL: $Url"
    }
    if ($uri.UserInfo) { throw "URL must not contain credentials: $Url" }
    if ($uri.Query -or $uri.Fragment -or $Url.Contains("?") -or $Url.Contains("#")) {
        throw "URL must not contain a query or fragment: $Url"
    }
    if ($uri.Scheme -eq "https") { return }
    if ($uri.Scheme -eq "http" -and ($uri.Host -eq "127.0.0.1" -or $uri.Host -eq "localhost" -or $uri.Host -eq "[::1]" -or $uri.Host -eq "::1")) {
        return
    }
    throw "URL must use HTTPS unless the mirror is loopback: $Url"
}

function Read-ChecksumFile([string]$Path, [string]$AssetName) {
    $fields = @(((Get-Content -LiteralPath $Path -Raw) -split "\s+") | Where-Object { $_ })
    if ($fields.Count -ne 2 -or $fields[1] -ne $AssetName -or $fields[0] -notmatch "^[0-9A-Fa-f]{64}$") {
        throw "Invalid checksum file for $AssetName"
    }
    return $fields[0].ToLowerInvariant()
}

function Read-HerdrPin([string]$Path) {
    $pin = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $digest = [string]$pin.sha256.'windows-x86_64'
    if (-not $pin.repository -or -not $pin.tag -or -not $pin.version -or $digest -notmatch "^[0-9A-Fa-f]{64}$") {
        throw "herdr-release.json does not pin a Windows Herdr build"
    }
    return [pscustomobject]@{
        Repository = [string]$pin.repository
        Tag = [string]$pin.tag
        Version = [string]$pin.version
        Sha256 = $digest.ToLowerInvariant()
    }
}

# Mirrors install.sh: never replace a Herdr this installer did not install.
function Get-HerdrAction([bool]$PinnedInstalled, [bool]$OtherOnPath, [bool]$Replace) {
    if ($PinnedInstalled) { return "current" }
    if ($OtherOnPath -and -not $Replace) { return "keep" }
    return "install"
}

function Get-EnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $value = ""
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*(export\s+)?$([regex]::Escape($Name))=(.*)$") {
            $value = $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $value
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
    $done = $false
    $lines = foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*(export\s+)?$([regex]::Escape($Name))=") {
            if (-not $done) { "$Name=$Value" }
            $done = $true
        } else {
            $line
        }
    }
    if (-not $done) { $lines = @($lines) + "$Name=$Value" }
    Set-Content -LiteralPath $Path -Value $lines -Encoding ASCII
}

# ---------------------------------------------------------------------------
# Effects.

function Write-Step([string]$Message) { Write-Host $Message }

function Get-Download([string]$Url, [string]$OutFile) {
    Assert-DownloadUrl $Url
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-HerdrRecord([string]$StateFile) {
    if (Test-Path -LiteralPath $StateFile) {
        return (Get-Content -LiteralPath $StateFile -Raw).Trim()
    }
    return ""
}

function Add-UserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $Directory) {
        [Environment]::SetEnvironmentVariable("Path", (@($entries) + $Directory) -join ";", "User")
        Write-Step "Added $Directory to your user PATH (open a new terminal to use it)."
    }
    if (@($env:Path -split ";") -notcontains $Directory) { $env:Path = "$Directory;$env:Path" }
}

function Remove-UserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ -and $_ -ne $Directory })
    [Environment]::SetEnvironmentVariable("Path", $entries -join ";", "User")
}

function Invoke-Thyra([string]$Thyra, [string[]]$Arguments) {
    & $Thyra @Arguments
    return $LASTEXITCODE
}

function Uninstall-Thyra($Paths, [bool]$SkipServices, [bool]$SkipHerdr, [bool]$PurgeData) {
    if (-not $SkipServices -and (Test-Path -LiteralPath $Paths.Thyra)) {
        if ((Invoke-Thyra $Paths.Thyra @("service", "uninstall")) -ne 0) {
            Write-Warning "Could not remove the Thyra scheduled task; see thyra service --help."
        }
        if (-not $SkipHerdr -and (Invoke-Thyra $Paths.Thyra @("herdr", "uninstall")) -ne 0) {
            Write-Warning "Could not remove the Thyra-managed Herdr scheduled task."
        }
    }
    $record = Get-HerdrRecord $Paths.HerdrState
    if ($record -and -not $SkipHerdr) {
        $dir = Join-Path $Paths.HerdrRoot $record
        if (Test-Path -LiteralPath $dir) {
            Remove-Item -LiteralPath $dir -Recurse -Force
            Write-Step "Removed $dir"
        }
        Remove-Item -LiteralPath $Paths.HerdrState -Force -ErrorAction SilentlyContinue
    }
    foreach ($name in @("thyra.exe", "thyra.exe.previous", "herdr.cmd")) {
        Remove-Item -LiteralPath (Join-Path $Paths.BinDir $name) -Force -ErrorAction SilentlyContinue
    }
    Write-Step "Removed $($Paths.Thyra)"
    # Remove the directory only when nothing else lives in it.
    if ((Test-Path -LiteralPath $Paths.BinDir) -and -not (Get-ChildItem -LiteralPath $Paths.BinDir -Force)) {
        Remove-Item -LiteralPath $Paths.BinDir -Force
        Remove-UserPath $Paths.BinDir
    }
    if ($PurgeData) {
        if (Test-Path -LiteralPath $Paths.ConfigDir) {
            Remove-Item -LiteralPath $Paths.ConfigDir -Recurse -Force
            Write-Step "Removed $($Paths.ConfigDir)"
        }
    } elseif (Test-Path -LiteralPath $Paths.ConfigDir) {
        Write-Step "Kept $($Paths.ConfigDir) (tokens, connections, settings); -Purge removes it."
    }
    Write-Step "Herdr's own data in %APPDATA%\herdr was not changed."
}

function Install-Thyra {
    param(
        [string]$RequestedVersion,
        [string]$RequestedPort,
        [bool]$LanMode,
        [bool]$SkipServices,
        [bool]$SkipHerdr,
        [bool]$ForceHerdr,
        [bool]$RemoveMode,
        [bool]$PurgeData
    )
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if ($PurgeData -and -not $RemoveMode) { throw "-Purge requires -Uninstall" }
    if ($RequestedPort -and (-not ($RequestedPort -match "^\d+$") -or [int]$RequestedPort -lt 1 -or [int]$RequestedPort -gt 65535)) {
        throw "Invalid port: $RequestedPort"
    }
    $RequestedVersion = ([string]$RequestedVersion).TrimStart("v")
    if ($RequestedVersion -and $RequestedVersion -notmatch "^[0-9A-Za-z._-]+$") {
        throw "Invalid version: $RequestedVersion"
    }

    $binDir = $env:THYRA_INSTALL_DIR
    if (-not $binDir) { $binDir = Join-Path $env:LOCALAPPDATA "Programs\Thyra" }
    $configDir = Join-Path $env:APPDATA "thyra"
    $paths = [pscustomobject]@{
        BinDir = $binDir
        Thyra = Join-Path $binDir "thyra.exe"
        ConfigDir = $configDir
        Config = Join-Path $configDir "thyra.env"
        HerdrRoot = Join-Path $configDir "herdr"
        HerdrState = Join-Path $configDir "installer-herdr.txt"
    }

    if ($RemoveMode) {
        Uninstall-Thyra $paths $SkipServices $SkipHerdr $PurgeData
        return
    }

    $platform = Get-ThyraPlatform (Get-OSArchitecture)
    $custom = $env:THYRA_INSTALL_BASE_URL
    if (-not $custom) { $custom = $env:THYRA_RELEASE_BASE_URL }
    $base = Get-ReleaseBase $custom $RequestedVersion
    Assert-DownloadUrl $base

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("thyra-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        # 1. Download and verify Thyra.
        if ($RequestedVersion) { $archive = "thyra-v$RequestedVersion-$platform.zip" } else { $archive = "thyra-$platform.zip" }
        Write-Step "Downloading Thyra for $platform..."
        Get-Download "$base/$archive" (Join-Path $tmp $archive)
        Get-Download "$base/$archive.sha256" (Join-Path $tmp "$archive.sha256")
        $expected = Read-ChecksumFile (Join-Path $tmp "$archive.sha256") $archive
        if ((Get-Sha256 (Join-Path $tmp $archive)) -ne $expected) { throw "Thyra package checksum mismatch" }
        Expand-Archive -LiteralPath (Join-Path $tmp $archive) -DestinationPath (Join-Path $tmp "thyra") -Force
        $packageDir = Join-Path $tmp "thyra\thyra-$platform"
        $fields = @(((Get-Content -LiteralPath (Join-Path $packageDir "VERSION") -Raw).Trim()) -split "\s+")
        if ($fields.Count -ne 3 -or $fields[0] -ne "thyra" -or $fields[2] -ne $platform) { throw "Invalid package VERSION file" }
        $packageVersion = $fields[1]
        if ($RequestedVersion -and $packageVersion -ne $RequestedVersion) { throw "Package version is $packageVersion, expected $RequestedVersion" }
        $newThyra = Join-Path $packageDir "thyra.exe"
        $reported = (& $newThyra --version | Out-String).Trim()
        if ($reported -ne "thyra $packageVersion") { throw "Binary version does not match package VERSION" }

        # 2. Download and verify the pinned Herdr build (x86_64; ARM64 uses emulation).
        $herdrPlan = "skip"
        $pin = $null
        if (-not $SkipHerdr) {
            try {
                Get-Download "$base/herdr-release.json" (Join-Path $tmp "herdr-release.json")
                $pin = Read-HerdrPin (Join-Path $tmp "herdr-release.json")
            } catch {
                Write-Warning "This release does not pin a Herdr build; skipping Herdr. ($($_.Exception.Message))"
            }
        }
        if ($pin) {
            $herdrDir = Join-Path $paths.HerdrRoot $pin.Tag
            # thyra herdr setup verifies the same pin into the same directory.
            $pinnedInstalled = Test-Path -LiteralPath (Join-Path $herdrDir "herdr.exe")
            $other = Get-Command "herdr.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            $herdrPlan = Get-HerdrAction $pinnedInstalled ($null -ne $other) $ForceHerdr
            if ($herdrPlan -eq "install") {
                $herdrBase = $env:THYRA_HERDR_BASE_URL
                if (-not $herdrBase) { $herdrBase = "https://github.com/$($pin.Repository)/releases/download/$($pin.Tag)" }
                $herdrBase = $herdrBase.TrimEnd("/")
                Write-Step "Downloading Herdr $($pin.Version) ($($pin.Repository) $($pin.Tag))..."
                $zip = Join-Path $tmp "herdr-windows-x86_64.zip"
                Get-Download "$herdrBase/herdr-windows-x86_64.zip" $zip
                if ((Get-Sha256 $zip) -ne $pin.Sha256) { throw "Herdr checksum mismatch" }
                Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp "herdr") -Force
                if (-not (Test-Path -LiteralPath (Join-Path $tmp "herdr\herdr.exe"))) { throw "The Herdr archive does not contain herdr.exe" }
            }
        }

        # 3. Install. A running thyra.exe cannot be overwritten but can be renamed.
        New-Item -ItemType Directory -Force -Path $paths.BinDir | Out-Null
        $previous = "$($paths.Thyra).previous"
        if (Test-Path -LiteralPath $paths.Thyra) {
            Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $paths.Thyra -Destination $previous -Force
        }
        Copy-Item -LiteralPath $newThyra -Destination $paths.Thyra -Force
        Write-Step "Installed Thyra $packageVersion to $($paths.Thyra)"
        Add-UserPath $paths.BinDir

        if ($herdrPlan -eq "install") {
            New-Item -ItemType Directory -Force -Path $paths.HerdrRoot | Out-Null
            if (Test-Path -LiteralPath $herdrDir) { Remove-Item -LiteralPath $herdrDir -Recurse -Force }
            Move-Item -LiteralPath (Join-Path $tmp "herdr") -Destination $herdrDir
            Set-Content -LiteralPath $paths.HerdrState -Value $pin.Tag -Encoding ASCII
            Write-Step "Installed Herdr $($pin.Version) to $herdrDir"
        } elseif ($herdrPlan -eq "current") {
            Set-Content -LiteralPath $paths.HerdrState -Value $pin.Tag -Encoding ASCII
            Write-Step "Herdr $($pin.Version) at $herdrDir is already current"
        } elseif ($herdrPlan -eq "keep") {
            Write-Step "Keeping the existing Herdr at $($other.Source)."
            Write-Step "  Thyra is tested with Herdr $($pin.Version) from $($pin.Repository); rerun with -ReplaceHerdr to install it."
        }
        if ($pin -and $herdrPlan -ne "keep") {
            # A cmd shim keeps `herdr` usable from any terminal across upgrades.
            Set-Content -LiteralPath (Join-Path $paths.BinDir "herdr.cmd") -Encoding ASCII -Value "@`"$(Join-Path $herdrDir 'herdr.exe')`" %*"
        }

        # 4. Services (per-user scheduled tasks created by thyra itself).
        $port = $RequestedPort
        $serviceInstalled = $false
        if (-not $SkipServices) {
            New-Item -ItemType Directory -Force -Path $paths.ConfigDir | Out-Null
            if (-not (Test-Path -LiteralPath $paths.Config)) {
                if (-not $port) { $port = "8787" }
                if ($LanMode) { $hostValue = "0.0.0.0" } else { $hostValue = "127.0.0.1" }
                Set-Content -LiteralPath $paths.Config -Encoding ASCII -Value @(
                    "# Thyra service environment. Created by the Thyra installer and preserved on",
                    "# upgrade; run thyra service restart after editing.",
                    "# HOST=127.0.0.1 accepts only this computer and needs no login. For phones and",
                    "# other computers, publish it privately with Tailscale Serve, or set",
                    "# HOST=0.0.0.0 to require the generated login token on your LAN.",
                    "HOST=$hostValue",
                    "PORT=$port",
                    "",
                    "# THYRA_PASSWORD=replace-with-a-strong-password",
                    "# THYRA_LOG_LEVEL=info"
                )
                Write-Step "Created $($paths.Config)"
            } else {
                if ($RequestedPort) { Set-EnvValue $paths.Config "PORT" $RequestedPort }
                if ($LanMode) { Set-EnvValue $paths.Config "HOST" "0.0.0.0" }
            }
            if ($pin -and $herdrPlan -ne "keep") {
                $savedPath = $env:Path
                try {
                    $env:Path = "$herdrDir;$env:Path"
                    if ((Invoke-Thyra $paths.Thyra @("herdr", "setup")) -ne 0) {
                        Write-Warning "Herdr did not start; open Thyra and choose Set up Herdr, or run: thyra herdr setup"
                    }
                } finally {
                    $env:Path = $savedPath
                }
            } elseif (-not $SkipHerdr -and (Invoke-Thyra $paths.Thyra @("herdr", "setup")) -ne 0) {
                Write-Warning "Herdr did not start; run: thyra herdr setup"
            }
            if ((Invoke-Thyra $paths.Thyra @("service", "install")) -eq 0) {
                $serviceInstalled = $true
            } else {
                Write-Warning "Could not install the Thyra scheduled task; see thyra service --help."
            }
        }

        # 5. Summary.
        Write-Host ""
        if ($serviceInstalled) {
            $port = Get-EnvValue $paths.Config "PORT"
            if (-not $port) { $port = "8787" }
            $hostValue = Get-EnvValue $paths.Config "HOST"
            $healthy = $false
            for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
                try {
                    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$port/healthz" | Out-Null
                    $healthy = $true
                } catch {
                    Start-Sleep -Seconds 1
                }
            }
            if ($healthy) { Write-Step "Thyra $packageVersion is running." } else { Write-Warning "Thyra did not answer on port $port yet; check: thyra service status" }
            if ($hostValue -eq "127.0.0.1" -or $hostValue -eq "localhost" -or -not $hostValue) {
                Write-Step "  Open http://127.0.0.1:$port on this computer (no login needed)."
            } else {
                Write-Step "  Use the tokenized URL printed above; the token is in $($paths.ConfigDir)\auth-token."
            }
            Write-Step "  Service config: $($paths.Config)"
        } else {
            if (-not $port) { $port = "8787" }
            Write-Step "Thyra $packageVersion is installed. Start it with: thyra (then open http://127.0.0.1:$port)"
        }
        Write-Host ""
        Write-Step "Next steps:"
        Write-Step "  - Phone and other devices: join Tailscale on both, then run"
        Write-Step "      tailscale serve --bg --https=443 http://127.0.0.1:$port"
        Write-Step "    and open the printed https://<machine>.<tailnet>.ts.net address."
        Write-Step "  - Install as an app: open Thyra in Edge or Chrome and choose Install app."
        Write-Step "  - Herdr on Windows is a beta; for SSH-hosted Herdr, run Thyra on a Linux or macOS machine or in WSL."
        Write-Step "  - Upgrade: rerun this installer. Remove: rerun it with -Uninstall."
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($env:THYRA_INSTALLER_LIBRARY -ne "1") {
    Install-Thyra -RequestedVersion $Version -RequestedPort $Port -LanMode $Lan.IsPresent `
        -SkipServices ($NoService.IsPresent -or $env:THYRA_NO_SERVICE -eq "1") `
        -SkipHerdr ($NoHerdr.IsPresent -or $env:THYRA_NO_HERDR -eq "1") `
        -ForceHerdr $ReplaceHerdr.IsPresent -RemoveMode $Uninstall.IsPresent -PurgeData $Purge.IsPresent
}
