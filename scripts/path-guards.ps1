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
    if (-not $targetFull.StartsWith($baseFull + [System.IO.Path]::DirectorySeparatorChar, $comparison)) {
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
