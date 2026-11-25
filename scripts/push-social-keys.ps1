# Copies the Reels Factory keys from .env.social on this PC to HeyZubi's private key file on the computer.
# The owner runs it. Keys are never printed, never on a command line, and travel only inside the ssh connection.
# Each key is checked with a free call first; a refused key is not saved.
param([string]$EnvFile = (Join-Path $PSScriptRoot '..\.env.social'), [string]$SshHost = 'hermes-box', [string]$Container = 'ops-heyzubi-live-1', [string]$KeysFile = '/opt/hq/data/social/keys.json')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EnvFile)) { Write-Host "Not found: $EnvFile"; exit 1 }

$names = [ordered]@{ TOPVIEW_API_PLATFORM_KEY = 'topview'; KIE_API_KEY = 'kie' }
$lines = Get-Content -LiteralPath $EnvFile -Encoding UTF8
$send = @{}
foreach ($n in $names.Keys) {
  $v = ''
  foreach ($l in $lines) { if ($l -match "^\s*$n\s*=(.*)$") { $v = $Matches[1].Trim().Trim('"').Trim("'").Trim() } }
  $from = '.env.social'
  if ($v -eq '' -or $v -like 'PASTE_*') {
    $v = [string][Environment]::GetEnvironmentVariable($n, 'User'); $from = 'the Windows user variable'
    if ($v -eq '') { Write-Host "$($names[$n]): no key, skipped"; continue }
  } elseif ($v -like 'op://*') {
    if (-not (Get-Command op -ErrorAction SilentlyContinue)) { Write-Host "$($names[$n]): that is a 1Password reference, but the 1Password CLI (op) isn't installed"; exit 1 }
    $v = [string](& op read $v); $from = '1Password'
    if ($LASTEXITCODE -ne 0 -or $v -eq '') { Write-Host "$($names[$n]): 1Password gave no key"; exit 1 }
  }
  $v = $v.Trim()
  if ($v.Length -lt 12 -or $v.Length -gt 400 -or $v -match '\s') { Write-Host "$($names[$n]): that doesn't look like a key (from $from)"; exit 1 }
  Write-Host "$($names[$n]): using $from"
  $send[$names[$n]] = $v
}
if ($send.Count -eq 0) { Write-Host 'Nothing to send.'; exit 1 }

$js = @'
const fs = require("fs"), path = require("path"), f = process.argv[1];
let t = ""; process.stdin.on("data", (d) => (t += d)).on("end", async () => {
  try {
    const add = JSON.parse(Buffer.from(t.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("utf8"));
    if (add.topview) {
      const base = (process.env.TOPVIEW_API_BASE || "https://platform-backend.topview.ai").replace(/\/+$/, "");
      const r = await fetch(base + "/api/v1/media/files", { headers: { Authorization: "Bearer " + add.topview, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j.code !== undefined && j.code !== null && j.code !== 200)) { console.log("topview: TopView refused the key (HTTP " + r.status + "). Nothing was saved."); process.exit(1); }
      console.log("topview: TopView accepted it");
    }
    if (add.kie) {
      const r = await fetch("https://api.kie.ai/api/v1/chat/credit", { headers: { Authorization: "Bearer " + add.kie }, signal: AbortSignal.timeout(60000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.code !== 200) { console.log("kie: kie.ai refused the key (" + (j.code || r.status) + "). Nothing was saved."); process.exit(1); }
      console.log("kie: kie.ai accepted it, " + j.data + " credits");
    }
    let all = {}; try { all = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("the key file on the computer can't be read"); }
    Object.assign(all, add);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".new"; fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, f);
    console.log("saved: " + Object.keys(add).join(", "));
  } catch (e) { console.log("Not saved: " + (e instanceof SyntaxError ? "the keys didn't arrive whole" : e.message)); process.exit(1); }
});
'@
$utf8 = New-Object System.Text.UTF8Encoding($false)
$code = [Convert]::ToBase64String($utf8.GetBytes($js))
$data = [Convert]::ToBase64String($utf8.GetBytes(($send | ConvertTo-Json -Compress)))
$OutputEncoding = [System.Text.Encoding]::ASCII
$data | & ssh $SshHost "docker exec -i $Container node -e 'eval(atob(process.argv[2]))' $KeysFile $code"
exit $LASTEXITCODE
