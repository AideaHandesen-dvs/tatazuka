# 佇か（tatazuka）ワンライナー導入 — Windows（Task Scheduler ログオン＋時刻トリガ）。
# 署名の壁（SmartScreen）を避けるリモートスクリプト導入（deploy/README「層② の落とし所」）。
#
#   irm https://raw.githubusercontent.com/AideaHandesen-dvs/tatazuka/main/deploy/install.ps1 | iex
#
# やること：node を用意 → repo 取得 → 証明書を作る → Task Scheduler 登録（①）→ 起動。
# 管理者は不要（FW で LAN 開放したいときだけ admin・無ければ localhost で動く）。env 無くても起動（PE）。冪等。
#
# ※ 配信は irm|iex で。irm が HTTP の charset=utf-8 でデコードするので日本語が壊れない。保存して
#    powershell -File で叩くなら UTF-8 BOM 付きで保存すること（PS5.1 は BOM 無し非 ASCII を CP932 で誤読する）。
#
# オプション（引数で渡す。irm|iex 経由なら: & ([scriptblock]::Create((irm <url>))) --mkcert 等）：
#   -ForceCert      既存の証明書を作り直す
#   -Openssl        証明書を openssl で（既定は mkcert）
#   -Tailscale      Tailscale Serve で tailnet ホスト名に本物の Let's Encrypt（端末で警告ゼロ・要 tailscale up）
#   -Port <N>       待受ポート（既定 8443）
#   -Branch <name>  取得する git ブランチ（既定 main）
#   -Uninstall      タスクを止めて外す（repo/証明書/env は残す）
param(
  [switch]$ForceCert,
  [switch]$Openssl,
  [switch]$Tailscale,
  [int]$Port = 8443,
  [string]$Branch = 'main',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$RepoSlug   = 'AideaHandesen-dvs/tatazuka'
$NodeVer    = 'v20.20.2'
$MkcertVer  = 'v1.4.4'
$NodeMin    = 18
$Repo       = Join-Path $env:USERPROFILE 'tatazuka'
$Cfg        = Join-Path $env:USERPROFILE '.config\tatazuka'
$TaskName   = 'tatazuka'

function Say ($m){ Write-Host "佇か $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "佇か $m" -ForegroundColor Yellow }
function Die ($m){ Write-Host "佇か NG $m" -ForegroundColor Red; exit 1 }

# ---- Tailscale Serve（-Tailscale）：tatazuka は自己署名 HTTPS のまま、Tailscale が前段で本物の LE を被せる ----
function TsBin {
  $c = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
  if($c){ return $c }
  $p = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if(Test-Path $p){ return $p }
  return $null
}
function TsTeardown {
  $ts = TsBin; if(-not $ts){ return }
  $eap=$ErrorActionPreference;$ErrorActionPreference='Continue'
  & $ts serve --https=443 off 2>&1 | Out-Null
  if($LASTEXITCODE -ne 0){ & $ts serve reset 2>&1 | Out-Null }
  $ErrorActionPreference=$eap
}

# ---- uninstall ----
if($Uninstall){
  schtasks /End /TN $TaskName 2>&1 | Out-Null
  schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\tatazuka\*" -or $_.Path -like "*\opt\node\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  TsTeardown   # -Tailscale で設定してた場合だけ効く（無ければ no-op）
  Say "タスクを外した。repo（$Repo）・証明書・env は残してある（消すなら手で）。"
  exit 0
}

# ============================ 1) node ============================
# node -v を PS 側で parse（node -p '...".".' は PS5.1 がネイティブ引数の " を食って壊れる＝実機で確認）。
function NodeMajor($exe){ try { [int](((& $exe -v 2>$null) -replace '^v','') -split '\.')[0] } catch { 0 } }
$NodeExe = $null
$sys = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if($sys -and (NodeMajor $sys) -ge $NodeMin){ $NodeExe = $sys; Say "node 既存を使う（$(& $NodeExe -v)）" }
elseif((Test-Path "$env:USERPROFILE\opt\node\node.exe") -and (NodeMajor "$env:USERPROFILE\opt\node\node.exe") -ge $NodeMin){
  $NodeExe = "$env:USERPROFILE\opt\node\node.exe"; Say "node 既存を使う（~/opt/node: $(& $NodeExe -v)）"
} else {
  $arch = if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'arm64'}else{'x64'}
  $zip = "node-$NodeVer-win-$arch.zip"
  Say "node 不在 → prebuilt 取得（$NodeVer win-$arch）"
  $opt = Join-Path $env:USERPROFILE 'opt'; New-Item -ItemType Directory -Force -Path $opt | Out-Null
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVer/$zip" -OutFile (Join-Path $env:TEMP $zip) -UseBasicParsing
  $ex = Join-Path $env:TEMP 'nodex'; if(Test-Path $ex){ Remove-Item $ex -Recurse -Force }
  Expand-Archive -Path (Join-Path $env:TEMP $zip) -DestinationPath $ex -Force
  $inner = Get-ChildItem $ex -Directory | Where-Object { $_.Name -like 'node-*-win-*' } | Select-Object -First 1
  $nd = Join-Path $opt 'node'; if(Test-Path $nd){ Remove-Item $nd -Recurse -Force }
  Move-Item $inner.FullName $nd
  $NodeExe = Join-Path $nd 'node.exe'
  if((NodeMajor $NodeExe) -lt $NodeMin){ Die "prebuilt node が動かない" }
  Say "node 用意した（$(& $NodeExe -v) @ ~/opt/node）"
}

# ============================ 2) repo ============================
if(Test-Path (Join-Path $Repo '.git')){
  Say "repo 既存 → 更新（git pull）"
  git -C $Repo pull --ff-only 2>$null | Out-Null
} elseif(Test-Path (Join-Path $Repo 'server\serve.js')){
  Say "repo 既存（非 git）→ そのまま使う"
} elseif((Get-Command git -ErrorAction SilentlyContinue) -and (& { git clone --depth 1 --branch $Branch "https://github.com/$RepoSlug.git" $Repo 2>$null; $LASTEXITCODE -eq 0 })){
  Say "repo 取得（git clone $Branch）"
} else {
  Say "repo 取得（zip）"
  $tz = Join-Path $env:TEMP 'tzrepo.zip'
  Invoke-WebRequest "https://github.com/$RepoSlug/archive/refs/heads/$Branch.zip" -OutFile $tz -UseBasicParsing
  $ex = Join-Path $env:TEMP 'tzrepox'; if(Test-Path $ex){ Remove-Item $ex -Recurse -Force }
  Expand-Archive -Path $tz -DestinationPath $ex -Force
  $inner = Get-ChildItem $ex -Directory | Where-Object { $_.Name -like 'tatazuka-*' } | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $Repo | Out-Null
  Copy-Item (Join-Path $inner.FullName '*') $Repo -Recurse -Force
}
if(-not (Test-Path (Join-Path $Repo 'server\serve.js'))){ Die "repo が壊れてる（server\serve.js が無い）" }

# ============================ 3) 証明書 ============================
$Certs = Join-Path $Repo 'server\certs'; New-Item -ItemType Directory -Force -Path $Certs | Out-Null
$cert = Join-Path $Certs 'cert.pem'; $key = Join-Path $Certs 'key.pem'
$hn = $env:COMPUTERNAME.ToLower()
if((Test-Path $cert) -and (Test-Path $key) -and -not $ForceCert){
  Say "証明書は既存を使う（作り直すなら -ForceCert）"
} elseif($Openssl){
  if(-not (Get-Command openssl -ErrorAction SilentlyContinue)){ Die "openssl が無い（既定の mkcert を使うか openssl を入れて）" }
  Say "openssl で自己署名証明書（397日）"
  $cfg = Join-Path $env:TEMP 'tzssl.cnf'
  @"
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $hn.local
[v3]
subjectAltName = @alt
basicConstraints = CA:FALSE
[alt]
DNS.1 = localhost
DNS.2 = $hn
DNS.3 = $hn.local
IP.1 = 127.0.0.1
"@ | Set-Content $cfg -Encoding ascii
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & openssl req -x509 -newkey rsa:2048 -nodes -days 397 -keyout $key -out $cert -config $cfg 2>&1 | Out-Null
  $rc = $LASTEXITCODE; $ErrorActionPreference = $eap
  if($rc -ne 0){ Die "openssl 証明書生成に失敗" }
} else {
  # 既定：mkcert（単体 exe・PEM 出力）。CA を入れれば見る端末で警告ゼロ。
  $mk = (Get-Command mkcert -ErrorAction SilentlyContinue).Source
  if(-not $mk){
    $ma = if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'arm64'}else{'amd64'}
    Say "mkcert 取得（$MkcertVer windows-$ma）"
    New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE 'opt\bin') | Out-Null
    $mk = Join-Path $env:USERPROFILE 'opt\bin\mkcert.exe'
    Invoke-WebRequest "https://github.com/FiloSottile/mkcert/releases/download/$MkcertVer/mkcert-$MkcertVer-windows-$ma.exe" -OutFile $mk -UseBasicParsing
  }
  Say "mkcert で証明書（ローカル CA を install）"
  # mkcert は注記を stderr に出す。PS5.1＋Stop は native stderr を terminating 化するので（2>&1 でも不可・
  # 実機で確認）、生成の間だけ EAP=Continue にし、成否は Test-Path で明示判定する。
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $mk -install 2>&1 | Out-Null
  & $mk -cert-file $cert -key-file $key localhost 127.0.0.1 ::1 $hn "$hn.local" 2>&1 | Out-Null
  $ErrorActionPreference = $eap
  if(-not (Test-Path $cert)){ Die "mkcert 証明書生成に失敗" }
}

# ============================ 4) env（PE） ============================
New-Item -ItemType Directory -Force -Path $Cfg | Out-Null
$envf = Join-Path $Cfg 'tatazuka.env'
if(-not (Test-Path $envf)){ Copy-Item (Join-Path $Repo 'deploy\systemd\tatazuka.env.example') $envf }
if($Port -ne 8443){
  $lines = @(Get-Content $envf | Where-Object { $_ -notmatch '^PORT=' }) + "PORT=$Port"
  Set-Content $envf -Value $lines -Encoding ascii
}

# ============================ 5) Task Scheduler 登録＆起動 ============================
# UserId は現ユーザーの SID 直（対話でも ssh でも名前解決の罠 WORKGROUP\... を避ける）。
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$xml = Get-Content (Join-Path $Repo 'deploy\windows\tatazuka.xml') -Raw
$xml = $xml -replace '__REPO__', $Repo -replace '__USER__', $sid -replace 'encoding="UTF-8"', 'encoding="UTF-16"'
$xp = Join-Path $env:TEMP 'tatazuka.xml'
Set-Content $xp -Value $xml -Encoding Unicode
schtasks /Create /TN $TaskName /XML $xp /F | Out-Null
schtasks /Run /TN $TaskName | Out-Null   # ログオン後の即時起動（systemd の enable --now 相当）

# FW で LAN 開放（admin のときだけ・無ければ localhost で動く）
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($admin){
  netsh advfirewall firewall delete rule name="tatazuka-$Port" 2>&1 | Out-Null
  netsh advfirewall firewall add rule name="tatazuka-$Port" dir=in action=allow protocol=TCP localport=$Port 2>&1 | Out-Null
  Say "ファイアウォール開放（TCP $Port・LAN から見える）"
} else {
  Warn "管理者でないので FW 未開放＝localhost のみ。LAN の他端末から見るには管理者で再実行 or 手で TCP $Port を許可。"
}

# ============================ 6) 確認（node クライアントで 200） ============================
Start-Sleep -Seconds 5
$cli = Join-Path $env:TEMP 'tzget.js'
@'
const https=require('https');
const req=https.get({host:'127.0.0.1',port:process.argv[2],path:'/',rejectUnauthorized:false,timeout:8000},res=>{let n=0;res.on('data',d=>n+=d.length);res.on('end',()=>console.log('STATUS='+res.statusCode+' BYTES='+n));});
req.on('error',e=>console.log('ERR='+e.message));req.on('timeout',()=>{console.log('TIMEOUT');req.destroy();});
'@ | Set-Content $cli -Encoding ASCII
$r = (& $NodeExe $cli $Port 2>&1 | Out-String).Trim()
if($r -like 'STATUS=200*'){ Say "起動確認 OK（HTTPS $r）" } else { Warn "起動未確認（$r）。ログ: $env:USERPROFILE\.config\tatazuka\tatazuka.log" }

# Tailscale Serve（-Tailscale）：ローカル起動が立った後に前段プロキシを張る。
$tsName = $null
if($Tailscale){
  $ts = TsBin
  if(-not $ts){ Die "tailscale が無い。先に Tailscale を入れて 'tailscale up' で tailnet に参加して（https://tailscale.com/download）。" }
  & $ts status 2>&1 | Out-Null
  if($LASTEXITCODE -ne 0){ Die "tailscale にログインしてない。'$ts up' を実行してから流し直して。" }
  Say "Tailscale Serve を設定（ローカル :$Port へプロキシ・tailnet に本物の Let's Encrypt）"
  $eap=$ErrorActionPreference;$ErrorActionPreference='Continue'
  & $ts serve --bg "https+insecure://localhost:$Port" 2>&1 | Out-Null
  if($LASTEXITCODE -ne 0){ & $ts serve https:443 / "https+insecure://localhost:$Port" 2>&1 | Out-Null }
  $rc=$LASTEXITCODE;$ErrorActionPreference=$eap
  if($rc -ne 0){ Die "tailscale serve に失敗。'$ts serve status' を確認して。" }
  # tailnet FQDN を status --json から node で抜く
  $tj = Join-Path $env:TEMP 'tzts.js'
  @'
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=((JSON.parse(s).Self||{}).DNSName||"").replace(/\.$/,"");if(n)console.log(n);}catch(e){}});
'@ | Set-Content $tj -Encoding ASCII
  $tsName = ((& $ts status --json 2>$null | Out-String) | & $NodeExe $tj 2>$null | Out-String).Trim()
}

Write-Host ""
if($Tailscale){
  Say "佇か、常駐開始。tailnet のどの端末からでも↓へ（本物の証明書・警告ゼロ）："
  if($tsName){ Write-Host "       https://$tsName/" -ForegroundColor White }
  else { Write-Host "       https://<your-tailnet-host>/   （'tailscale serve status' で確認）" -ForegroundColor White }
} else {
  Say "佇か、常駐開始。見る端末のブラウザから↓へ（同じ LAN）："
  Write-Host "       https://$hn.local`:$Port/" -ForegroundColor White
}
Say "ログ: Get-Content `$env:USERPROFILE\.config\tatazuka\tatazuka.log -Tail 20 -Wait"
Say "外す: irm https://raw.githubusercontent.com/$RepoSlug/main/deploy/install.ps1 | iex   （に -Uninstall）"
exit 0
