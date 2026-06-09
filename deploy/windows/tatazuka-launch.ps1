# 佇か（tatazuka）Task Scheduler ラッパー（Windows / PowerShell）。
#
# Task Scheduler のタスク XML は env ファイルも ~ も展開しない。そこで起動をこのラッパーに
# 一段噛ませ、env を外出し読み込み・node を解決してから serve.js を前面実行する。
# systemd unit の EnvironmentFile=- / launchd ラッパーと同じ約束を Windows に移植したもの：
#   - 秘密（TZ_HASS_TOKEN / ANTHROPIC_API_KEY 等）はタスク XML でなく
#     %USERPROFILE%\.config\tatazuka\tatazuka.env へ（Linux/macOS と同じ場所）。
#   - env が無くても起動する（ルールベースで喋る＝プログレッシブ・エンハンスメント）。
#   - node のインストール場所に依存しない（PATH→定番の場所の順で探す）。
#
# 設置手順は deploy/README.md を参照。

$ErrorActionPreference = 'Stop'

# このスクリプトは <repo>\deploy\windows\ にある。serve.js は repo 基準で解決する
# （serve.js の証明書 / client パスは import.meta.url 基準なので cwd 非依存）。
$repo  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serve = Join-Path $repo 'server\serve.js'

# --- env を外出し（無ければルールベースで起動＝PE） ---------------------------
# 形式は systemd EnvironmentFile と同じ KEY=VALUE（# 行・空行は無視、値の "..." / '...' は剥がす）。
$envFile = Join-Path $env:USERPROFILE '.config\tatazuka\tatazuka.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $t.Substring(0, $i).Trim()
    $v = $t.Substring($i + 1).Trim()
    if ($v.Length -ge 2 -and
        (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    Set-Item -Path "Env:$k" -Value $v
  }
}

# --- ログ：%USERPROFILE%\.config\tatazuka\tatazuka.log（journal / ~/Library/Logs の対） ---
# node 解決より前に用意する。node 不在のような起動前失敗も必ずログに残すため
# （Hidden タスクの stderr はどこにも出ない＝ログが唯一の手掛かり）。
$logDir = Join-Path $env:USERPROFILE '.config\tatazuka'
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
$log = Join-Path $logDir 'tatazuka.log'

# --- node を解決：PATH 優先、無ければ定番の場所 -------------------------------
# 公式 msi（Program Files\nodejs）／scoop／~/opt\node（prebuilt zip を symlink した場所）。
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  # base が空（稀に ProgramFiles(x86) 不在）なら候補に入れない。Stop 下で Join-Path に null を渡すと落ちるため。
  # ${env:ProgramFiles(x86)} は名前中の () が PS 5.1 パーサを壊す（ブレース誤認＝実機で確認）。
  # GetEnvironmentVariable で曖昧さなく取る。
  $pf   = [Environment]::GetEnvironmentVariable('ProgramFiles')
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $cands = @()
  if ($pf)   { $cands += (Join-Path $pf   'nodejs\node.exe') }
  if ($pf86) { $cands += (Join-Path $pf86 'nodejs\node.exe') }
  $cands += (Join-Path $env:USERPROFILE 'opt\node\node.exe')
  $cands += (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe')
  foreach ($cand in $cands) {
    if (Test-Path -LiteralPath $cand) { $node = $cand; break }
  }
}
if (-not $node) {
  # Write-Error は Stop 下で terminating＝exit 127 に届かず exit 1 になり、しかも stderr は
  # Hidden タスクで消える（実機で確認）。ログに直接書いて 127 で抜ける。
  ("[{0}] 佇か: node が見つからない（PATH か Program Files\nodejs などに入れて）" -f (Get-Date -Format s)) |
    Out-File -FilePath $log -Append -Encoding utf8
  exit 127
}

# node を前面で実行する。このプロセス（powershell）がタスクの本体なので、node の終了コードが
# そのままタスク結果になる：非ゼロ（＝クラッシュ）なら XML の RestartOnFailure が起こし直す
# （systemd Restart=on-failure / launchd KeepAlive の対）。
# PowerShell 7.4+ は Stop 下でネイティブの非ゼロ終了を例外化するので Continue に戻し、
# 終了コードの伝播を $LASTEXITCODE 一本に確定させる（クラッシュ判定をブレさせない）。
$ErrorActionPreference = 'Continue'
& $node $serve *>> $log
exit $LASTEXITCODE
