function Get-SafeChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseDir,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $baseFull = [System.IO.Path]::GetFullPath($BaseDir).TrimEnd([char[]]@("\", "/"))
    if ([System.IO.Path]::IsPathRooted($Path)) {
        $targetFull = [System.IO.Path]::GetFullPath($Path)
    } else {
        $targetFull = [System.IO.Path]::GetFullPath((Join-Path $baseFull $Path))
    }
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    if ($targetFull.Equals($baseFull, $comparison) -or -not $targetFull.StartsWith($baseFull + [System.IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "Unsafe path outside workspace: $Path"
    }
    return $targetFull
}

function Remove-DirectoryInsideRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseDir,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $target = Get-SafeChildPath -BaseDir $BaseDir -Path $Path
    if (-not (Test-Path -LiteralPath $target)) {
        return
    }
    Assert-NoReparsePointAncestor -BaseDir $BaseDir -Path $target
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to recursively remove reparse point: $target"
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}

function Copy-DirectoryContentsInsideRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseDir,
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$DestinationDir
    )

    $source = Get-SafeChildPath -BaseDir $BaseDir -Path $SourceDir
    if (-not (Test-Path -LiteralPath $source)) {
        return
    }

    $destination = Get-SafeChildPath -BaseDir $BaseDir -Path $DestinationDir
    Assert-NoReparsePointAncestor -BaseDir $BaseDir -Path $source
    Assert-NoReparsePointAncestor -BaseDir $BaseDir -Path $destination

    $sourceItem = Get-Item -LiteralPath $source -Force
    if (-not $sourceItem.PSIsContainer) {
        throw "Copy source is not a directory: $source"
    }
    if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to copy from reparse point: $source"
    }

    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $sourceFull = [System.IO.Path]::GetFullPath($source).TrimEnd([char[]]@("\", "/"))
    $destinationFull = [System.IO.Path]::GetFullPath($destination).TrimEnd([char[]]@("\", "/"))
    $sourcePrefix = $sourceFull + [System.IO.Path]::DirectorySeparatorChar
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    $pending = New-Object System.Collections.ArrayList
    [void]$pending.Add($sourceFull)

    while ($pending.Count -gt 0) {
        $current = [string]$pending[0]
        $pending.RemoveAt(0)
        foreach ($item in Get-ChildItem -LiteralPath $current -Force) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to copy reparse point from include directory: $($item.FullName)"
            }

            $itemFull = [System.IO.Path]::GetFullPath($item.FullName)
            if (-not $itemFull.StartsWith($sourcePrefix, $comparison)) {
                throw "Refusing to copy source path outside include directory: $($item.FullName)"
            }
            $relative = $itemFull.Substring($sourcePrefix.Length)
            $target = Get-SafeChildPath -BaseDir $destinationFull -Path $relative

            if ($item.PSIsContainer) {
                New-Item -ItemType Directory -Force -Path $target | Out-Null
                [void]$pending.Add($itemFull)
                continue
            }

            $targetParent = [System.IO.Path]::GetDirectoryName($target)
            Assert-NoReparsePointAncestor -BaseDir $destinationFull -Path $targetParent
            New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
            if (Test-Path -LiteralPath $target) {
                $targetItem = Get-Item -LiteralPath $target -Force
                if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Refusing to overwrite reparse point: $target"
                }
            }
            Copy-Item -LiteralPath $itemFull -Destination $target -Force
        }
    }
}

function Assert-NoReparsePointAncestor {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseDir,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $baseFull = [System.IO.Path]::GetFullPath($BaseDir).TrimEnd([char[]]@("\", "/"))
    $targetFull = [System.IO.Path]::GetFullPath($Path)
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    if (-not $targetFull.Equals($baseFull, $comparison) -and -not $targetFull.StartsWith($baseFull + [System.IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "Unsafe path outside workspace: $Path"
    }

    $current = $targetFull
    while ($current.Length -gt $baseFull.Length) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to use path through reparse point: $current"
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent.Equals($current, $comparison)) {
            break
        }
        $current = $parent
    }
}

function ConvertTo-SafeArchiveEntryName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $raw = $Name.Replace("\", "/")
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw.StartsWith("/") -or $raw -match '^[A-Za-z]:') {
        throw "Archive contains unsafe entry path '$Name'."
    }

    $segments = $raw.Split("/")
    $safeSegments = @()
    for ($i = 0; $i -lt $segments.Count; $i += 1) {
        $segment = $segments[$i]
        if ($segment -eq "" -and $i -eq $segments.Count - 1) {
            continue
        }
        if ($segment -eq "" -or $segment -eq "." -or $segment -eq "..") {
            throw "Archive contains unsafe entry path '$Name'."
        }
        if ($segment -match '[<>:"|?*]') {
            throw "Archive contains Windows-invalid entry path '$Name'."
        }
        $stem = $segment.Split(".")[0].ToUpperInvariant()
        if ($stem -in @("CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9")) {
            throw "Archive contains Windows-reserved entry path '$Name'."
        }
        $safeSegments += $segment
    }
    if ($safeSegments.Count -eq 0) {
        throw "Archive contains unsafe entry path '$Name'."
    }
    return $safeSegments -join "/"
}
