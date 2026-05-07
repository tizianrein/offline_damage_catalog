# =============================================================
# setup-vendor.ps1 — lädt Three.js + JSZip nach ./vendor/
# Für Windows (PowerShell, VS Code Terminal).
#
# Ausführen aus dem Repo-Ordner:
#   ./setup-vendor.ps1
#
# Falls "Ausführen von Skripten ist auf diesem System deaktiviert":
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# (gilt nur für die aktuelle Terminal-Sitzung)
# =============================================================

$ErrorActionPreference = "Stop"

$threeVersion = "0.161.0"
$jszipVersion = "3.10.1"

$threeBase = "https://cdn.jsdelivr.net/npm/three@$threeVersion"
$jszipBase = "https://cdn.jsdelivr.net/npm/jszip@$jszipVersion"

# Liste: URL -> Zielpfad
$files = @(
    @{ Url = "$threeBase/build/three.module.js";
       Out = "vendor/three/build/three.module.js" },
    @{ Url = "$threeBase/examples/jsm/loaders/GLTFLoader.js";
       Out = "vendor/three/examples/jsm/loaders/GLTFLoader.js" },
    @{ Url = "$threeBase/examples/jsm/loaders/PLYLoader.js";
       Out = "vendor/three/examples/jsm/loaders/PLYLoader.js" },
    @{ Url = "$threeBase/examples/jsm/controls/OrbitControls.js";
       Out = "vendor/three/examples/jsm/controls/OrbitControls.js" },
    @{ Url = "$threeBase/examples/jsm/utils/BufferGeometryUtils.js";
       Out = "vendor/three/examples/jsm/utils/BufferGeometryUtils.js" },
    @{ Url = "$jszipBase/+esm";
       Out = "vendor/jszip/jszip.esm.js" }
)

foreach ($f in $files) {
    $dir = Split-Path $f.Out -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Write-Host "==> $($f.Url)"
    Write-Host "    -> $($f.Out)"
    Invoke-WebRequest -Uri $f.Url -OutFile $f.Out -UseBasicParsing
}

Write-Host ""
Write-Host "Fertig. Heruntergeladen:"
Get-ChildItem -Path vendor -Recurse -File |
    Select-Object FullName, @{N='KB';E={[math]::Round($_.Length/1KB,1)}} |
    Format-Table
Write-Host ""
Write-Host "Jetzt den 'vendor/' Ordner mit committen und pushen."
