# PDF TransNote のビルド：テスト → アイコンとライセンス文 → PyInstaller → zip → Inno Setup 7
# 使い方（このフォルダで）：powershell -ExecutionPolicy Bypass -File build.ps1 [-SkipTests] [-SkipInstaller]
# 出力：release\PdfTransNote-<版>-portable.zip と release\PdfTransNote-<版>-setup.exe
# 版は transnote\__init__.py の VERSION から読む．
# このファイルは UTF-8（BOM 付き）で保存する（Windows PowerShell 5.1 が日本語を読み違えないように）．

param(
    [switch]$SkipTests,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw ".venv がありません．先に py -3.14 -m venv .venv と pip install -r requirements-dev.txt を実行してください" }

function Invoke-Step([string]$Name, [scriptblock]$Block) {
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$Name に失敗しました（終了コード $LASTEXITCODE）" }
}

$version = (& $py -c "import transnote; print(transnote.VERSION)").Trim()
Write-Host "PDF TransNote $version"

# 0. PDF.js の公式配布物（vendor\ になければ取ってくる）
Invoke-Step "PDF.js" { & $py -m tools.fetch_pdfjs }

# 1. テスト
if (-not $SkipTests) {
    Invoke-Step "JavaScript のテスト" { node --test tests/ }
    Invoke-Step "Python のテスト" { & $py -m unittest discover -s tests }
}

# 2. 版情報（exe のプロパティ）．BOM なしの UTF-8 で書く
$parts = ($version.Split(".") + @("0", "0", "0"))[0..3] -join ", "
$vi = Get-Content "assets\version_info.txt" -Raw -Encoding UTF8
$vi = $vi -replace "filevers=\([^)]*\)", "filevers=($parts)" -replace "prodvers=\([^)]*\)", "prodvers=($parts)"
$vi = $vi -replace "StringStruct\('FileVersion', '[^']*'\)", "StringStruct('FileVersion', '$version')"
$vi = $vi -replace "StringStruct\('ProductVersion', '[^']*'\)", "StringStruct('ProductVersion', '$version')"
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "assets\version_info.txt"), $vi, (New-Object Text.UTF8Encoding $false))

# 3. アイコンとライセンス文
$env:PYTHONIOENCODING = "utf-8"
Invoke-Step "アイコン" { & $py -m tools.make_icon }
Invoke-Step "ライセンス文" { & $py -m tools.collect_licenses }

# 4. exe（dist\PdfTransNote）
Invoke-Step "PyInstaller" { & (Join-Path $PSScriptRoot ".venv\Scripts\pyinstaller.exe") --noconfirm --clean --log-level WARN PdfTransNote.spec }
$dist = Join-Path $PSScriptRoot "dist\PdfTransNote"
if (Test-Path "$dist\data") { Remove-Item "$dist\data" -Recurse -Force }  # 試しに動かしたときのデータは配らない
Copy-Item "LICENSES" "$dist\LICENSES" -Recurse -Force
Copy-Item "LICENSE" "$dist\LICENSE.txt" -Force
Copy-Item "README.md" "$dist\README.md" -Force

# 5. zip（解凍するだけで使える）
New-Item -ItemType Directory -Force "release" | Out-Null
$zip = Join-Path $PSScriptRoot "release\PdfTransNote-$version-portable.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "==> zip"
Compress-Archive -Path $dist -DestinationPath $zip

# 6. インストーラー（Inno Setup 7）
if (-not $SkipInstaller) {
    $iscc = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $iscc) { throw "Inno Setup 7（ISCC.exe）が見つかりません" }
    Invoke-Step "Inno Setup" { & $iscc /Qp "/DAppVersion=$version" "installer\PdfTransNote.iss" }
}

Write-Host "完了：" -ForegroundColor Green
Get-ChildItem "release" | Format-Table Name, @{ n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
