# Speak one line with Windows' own speech synthesis (no cloud service).
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File speak.ps1 -Text "..." [-Voice "Microsoft Huihui Desktop"] [-Rate 0] [-Volume 100]
#
# Serving the Coopanion extension cortico-world-pet-voice: one line per run, exits when done.
# Engine order: System.Speech (.NET), then SAPI 5 through COM (SpVoice).
# Exit codes: 0 = spoke (or -DryRun with a usable engine); 1 = no voice engine; 2 = bad arguments.
#
# This file must stay pure ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM, so
# non-ASCII text here would garble. The text to speak arrives as a -Text argument and is unaffected.

param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100,
  # Set up the engine and voice but say nothing: the extension and its self-test use this to probe.
  [switch]$DryRun,
  # Print one JSON line on success, so the Node side can report engine and voice.
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

function Clamp([int]$v, [int]$lo, [int]$hi) { [Math]::Max($lo, [Math]::Min($hi, $v)) }

$rate = Clamp $Rate -10 10
$volume = Clamp $Volume 0 100

# Pick a voice from the candidates: exact name first (case-insensitive), then substring, then the first.
function Pick-Voice($candidates, [string]$wanted) {
  $list = @($candidates)
  if ($list.Count -eq 0) { return $null }
  if (-not [string]::IsNullOrWhiteSpace($wanted)) {
    $exact = @($list | Where-Object { $_.Name -ieq $wanted })
    if ($exact.Count -eq 0) { $exact = @($list | Where-Object { $_.Name -like "*$wanted*" }) }
    if ($exact.Count -gt 0) { return $exact[0] }
  }
  return $list[0]
}

$result = $null
$engineError = ''

# --- 1. System.Speech (.NET) -------------------------------------------------
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @(
    $synth.GetInstalledVoices() |
      Where-Object { $_.Enabled } |
      ForEach-Object { [pscustomobject]@{ Name = $_.VoiceInfo.Name; Culture = $_.VoiceInfo.Culture.Name } }
  )
  $picked = Pick-Voice $voices $Voice
  if ($picked) {
    $synth.SelectVoice($picked.Name)
    $synth.Rate = $rate
    $synth.Volume = $volume
    if (-not $DryRun) { $synth.Speak($Text) | Out-Null }
    $result = [pscustomobject]@{ engine = 'system.speech'; voice = $picked.Name; culture = $picked.Culture }
  }
  $synth.Dispose()
} catch {
  $engineError = $_.Exception.Message
}

# --- 2. SAPI 5 through COM ---------------------------------------------------
if (-not $result) {
  try {
    $sp = New-Object -ComObject SAPI.SpVoice
    $voices = @(
      $sp.GetVoices() | ForEach-Object { [pscustomobject]@{ Token = $_; Name = $_.GetDescription() } }
    )
    $picked = Pick-Voice $voices $Voice
    if ($picked) {
      $sp.Voice = $picked.Token
      $sp.Rate = $rate
      $sp.Volume = $volume
      if (-not $DryRun) { $sp.Speak($Text, 0) | Out-Null }
      $result = [pscustomobject]@{ engine = 'sapi.com'; voice = $picked.Name; culture = '' }
    }
  } catch {
    if (-not $engineError) { $engineError = $_.Exception.Message }
  }
}

if (-not $result) {
  $why = if ($engineError) { $engineError } else { 'neither System.Speech nor SAPI 5 has a usable voice' }
  [Console]::Error.WriteLine("no-voice-engine: $why")
  exit 1
}

if ($Json) { $result | ConvertTo-Json -Compress }
exit 0
