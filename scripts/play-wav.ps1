# Play a WAV file with Windows' own Media.SoundPlayer, then exit.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File play-wav.ps1 -File "C:\...\line.wav" [-TimeoutMs 60000] [-DryRun]
#
# Serving the Coopanion extension cortico-world-pet-voice: cloud TTS returns audio bytes, the Node
# side writes them to a temp WAV, and this plays that file. SoundPlayer comes from System.Windows
# Extensions in the .NET Framework, which every Windows PowerShell 5.1 already has.
#
# -TimeoutMs is the authoritative cap on PLAYBACK time: on timeout we stop the sound and exit 0
# (the line was heard, wholly or partly). The Node side waits for this cap plus a margin for
# starting PowerShell. Note that starting powershell.exe itself costs about a second on a cold
# start, which is exactly why the cap lives here instead of in a process-level kill: a kill timer
# would have to guess how long the process takes to boot.
# -DryRun checks the file and the SoundPlayer type without playing.
#
# Exit codes: 0 = played (or -DryRun ok); 2 = bad arguments or the file cannot be read;
#             3 = Media.SoundPlayer is unavailable; 4 = playback threw.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.

param(
  [Parameter(Mandatory = $true)][string]$File,
  [int]$TimeoutMs = 60000,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
  [Console]::Error.WriteLine("no-such-file: $File")
  exit 2
}
try {
  $bytes = [System.IO.File]::ReadAllBytes($File)
} catch {
  [Console]::Error.WriteLine("unreadable: $($_.Exception.Message)")
  exit 2
}
if ($bytes.Length -lt 45) {
  [Console]::Error.WriteLine("too-small: $($bytes.Length) bytes is not a wav file")
  exit 2
}

try {
  Add-Type -AssemblyName System.Windows.Extensions -ErrorAction Stop
} catch {
  # Older frameworks have the type in System itself; try that before giving up.
  try { Add-Type -AssemblyName System -ErrorAction Stop } catch { }
}
try {
  $player = New-Object System.Media.SoundPlayer
} catch {
  [Console]::Error.WriteLine("no-soundplayer: $($_.Exception.Message)")
  exit 3
}

try {
  $player.SoundLocation = $File
  $player.Load()
} catch {
  [Console]::Error.WriteLine("load-failed: $($_.Exception.Message)")
  exit 3
}

if ($DryRun) { exit 0 }

try {
  $player.Play()          # asynchronous: returns at once
} catch {
  [Console]::Error.WriteLine("play-failed: $($_.Exception.Message)")
  exit 4
}

# Wait for the sound to finish, but never longer than the cap: the queue behind us must not hang.
# Parse the RIFF chunks instead of assuming a fixed 44-byte header: extra chunks, a BOM, or a
# different header layout would otherwise make the estimate wildly wrong and stall the queue.
$dataSize = 0
try {
  if ($bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq 'RIFF') {
    $pos = 12
    while ($pos + 8 -le $bytes.Length) {
      $id = [Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
      $size = [BitConverter]::ToUInt32($bytes, $pos + 4)
      if ($id -eq 'data') {
        $dataSize = [Math]::Min([int]$size, $bytes.Length - ($pos + 8))
        break
      }
      $pos += 8 + [int]$size + ([int]$size % 2)
      if ($size -le 0) { break }
    }
  }
} catch { $dataSize = 0 }
if ($dataSize -le 0) { $dataSize = [Math]::Max(0, $bytes.Length - 44) }

# Bytes per frame and sample rate come from the fmt chunk, never from a guess. Two mistakes are
# easy here and both stall the queue: assuming stereo (MiniMax returns 16-bit MONO), and
# forgetting to divide by the sample rate (dataSize/bytesPerFrame is a FRAME COUNT, not ms).
$channels = 1
$bits = 16
$rate = 32000
try {
  $fmtPos = 12
  while ($fmtPos + 8 -le $bytes.Length) {
    $fmtId = [Text.Encoding]::ASCII.GetString($bytes, $fmtPos, 4)
    $fmtSize = [BitConverter]::ToUInt32($bytes, $fmtPos + 4)
    if ($fmtId -eq 'fmt ' -and $fmtPos + 8 + 16 -le $bytes.Length) {
      $body = $fmtPos + 8
      $channels = [BitConverter]::ToUInt16($bytes, $body + 2)
      $rate = [BitConverter]::ToUInt32($bytes, $body + 4)
      $bits = [BitConverter]::ToUInt16($bytes, $body + 14)
      break
    }
    $fmtPos += 8 + [int]$fmtSize + ([int]$fmtSize % 2)
    if ($fmtSize -le 0) { break }
  }
} catch { $channels = 1; $bits = 16; $rate = 32000 }
if ($channels -lt 1) { $channels = 1 }
if ($bits -lt 8) { $bits = 16 }
if ($rate -lt 1) { $rate = 32000 }
$bytesPerFrame = ($bits / 8.0) * $channels

$ms = [int](($dataSize / $bytesPerFrame) / $rate * 1000)
$limit = [Math]::Min([Math]::Max($ms, 500), [Math]::Max(200, $TimeoutMs))
$waited = 0
while ($waited -lt $limit) {
  Start-Sleep -Milliseconds 50
  $waited += 50
}

try { $player.Stop() } catch { }
exit 0
