# ROG speech host (Windows PowerShell 5.1 + System.Speech, fully offline).
#
# The Electron main process runs voice-activity detection and sends each finished
# utterance here as 16 kHz / 16-bit / mono PCM. This host then recognizes it
# against the grammars for the requested mode:
#
#   wake    - Stage A: tiny wake grammar ("rog", "hey rog") + "rog <command>" one-shots
#   command - Stage B: known command phrases, "search youtube for <dictation>", dictation
#   confirm - yes / no
#
# It also speaks responses with the installed SAPI voices.
#
#   stdin  : JSON control messages, one per line
#   stdout : JSON events, one per line
#
# The host only reports what it heard and how confident the engine was. Every
# decision (thresholds, what to execute) lives in the Electron main process.
#
# Why a script rather than a compiled helper: Smart App Control blocks unsigned,
# freshly built executables. This file runs on Microsoft-signed components only.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = 8MB
$stdout = [Console]::Out

function Emit([hashtable]$ev) {
  $stdout.Write($json.Serialize($ev) + "`n")
  $stdout.Flush()
}

$state = @{
  wakeWords = @('rog', 'rogue', 'hey rog', 'okay rog')
  phrases   = @()
  prefixes  = @()
  quit      = $false
}

try {
  $culture = New-Object System.Globalization.CultureInfo 'en-US'
  $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -eq 'en-US' } | Select-Object -First 1
  if (-not $info) { Emit @{ t = 'fatal'; msg = 'No en-US Windows speech recognizer is installed.' }; exit 2 }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $info
  $engine.MaxAlternates = 3
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SetOutputToDefaultAudioDevice()
} catch {
  Emit @{ t = 'fatal'; msg = $_.Exception.Message }
  exit 1
}

# ------------------------------------------------------------------ grammars

function New-NamedGrammar($builder, [string]$name) {
  $builder.Culture = $culture
  $g = New-Object System.Speech.Recognition.Grammar $builder
  $g.Name = $name
  return $g
}

function New-Choices([string[]]$items) { return New-Object System.Speech.Recognition.Choices (, $items) }

function New-Builder([object]$part) {
  $gb = New-Object System.Speech.Recognition.GrammarBuilder
  if ($part -is [string]) { $gb.Append([string]$part) } else { $gb.Append([System.Speech.Recognition.Choices]$part) }
  return $gb
}

$modeGrammars = @{
  wake    = @('wake', 'filler', 'wake_command', 'wake_template', 'wake_dictation')
  command = @('command', 'template', 'dictation')
  confirm = @('confirm', 'confirm_filler')
  # Second pass when the strict grammars reject: free dictation only, so the main
  # process can fuzzy-match ("guess") the words against known commands.
  guess   = @('dictation')
}

function Set-GrammarMode([string]$mode) {
  $enabled = $modeGrammars[$mode]
  foreach ($g in $engine.Grammars) { $g.Enabled = ($enabled -contains $g.Name) }
}

function Build-Grammars {
  $engine.UnloadAllGrammars()
  $wake = New-Choices $state.wakeWords
  $engine.LoadGrammar((New-NamedGrammar (New-Builder $wake) 'wake'))

  # Rejection sink: common words absorb ordinary speech, so SAPI does not force
  # every utterance onto the wake word. A filler match means "not for ROG".
  $fillerWords = [string[]]@('the', 'a', 'and', 'so', 'yeah', 'okay', 'right', 'what', 'is', 'it', 'that',
    'this', 'i', 'you', 'we', 'to', 'of', 'in', 'no', 'yes', 'go', 'do', 'know', 'like', 'just', 'can',
    'work', 'code', 'dog', 'need', 'have', 'but', 'not', 'was', 'for', 'with', 'on', 'they', 'there',
    'then', 'now', 'here', 'well', 'really', 'around', 'think', 'good', 'time', 'today', 'nice', 'weather',
    'make', 'see', 'look', 'get', 'want', 'my', 'me', 'he', 'she', 'how', 'why', 'when', 'where', 'all')
  $filler = New-Choices $fillerWords
  $engine.LoadGrammar((New-NamedGrammar (New-Object System.Speech.Recognition.GrammarBuilder($filler, 1, 8)) 'filler'))

  if ($state.phrases.Count -gt 0) {
    $commands = New-Choices $state.phrases
    $engine.LoadGrammar((New-NamedGrammar (New-Builder $commands) 'command'))
    $wc = New-Builder $wake; $wc.Append($commands)
    $engine.LoadGrammar((New-NamedGrammar $wc 'wake_command'))
  }

  foreach ($prefix in $state.prefixes) {
    $t = New-Builder ([string]$prefix); $t.AppendDictation()
    $engine.LoadGrammar((New-NamedGrammar $t 'template'))
    $wt = New-Builder $wake; $wt.Append([string]$prefix); $wt.AppendDictation()
    $engine.LoadGrammar((New-NamedGrammar $wt 'wake_template'))
  }

  # "rog <anything>": lets ROG guess at phrasings that aren't exact triggers.
  $wd = New-Builder $wake; $wd.AppendDictation()
  $engine.LoadGrammar((New-NamedGrammar $wd 'wake_dictation'))

  $dict = New-Object System.Speech.Recognition.DictationGrammar
  $dict.Name = 'dictation'
  $engine.LoadGrammar($dict)

  $yesNo = New-Choices ([string[]]@('yes', 'yeah', 'yep', 'sure', 'do it', 'go ahead', 'confirm', 'okay',
      'no', 'nope', 'cancel', 'stop', 'never mind', 'don''t'))
  $engine.LoadGrammar((New-NamedGrammar (New-Builder $yesNo) 'confirm'))
  $confirmWords = @('yes', 'yeah', 'okay', 'no')
  $confirmFiller = New-Choices ([string[]]($fillerWords | Where-Object { $confirmWords -notcontains $_ }))
  $engine.LoadGrammar((New-NamedGrammar (New-Object System.Speech.Recognition.GrammarBuilder($confirmFiller, 1, 8)) 'confirm_filler'))

  Emit @{ t = 'grammar_loaded'; phrases = $state.phrases.Count; prefixes = $state.prefixes.Count }
}

function Clean-List($value, $fallback) {
  if ($null -eq $value) { return , $fallback }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($v in $value) {
    if ($v -is [string]) {
      $s = $v.Trim().ToLowerInvariant()
      if ($s.Length -gt 0 -and $s.Length -lt 120 -and -not $out.Contains($s)) { $out.Add($s) }
    }
    if ($out.Count -ge 2000) { break }
  }
  return , $out.ToArray()
}

# --------------------------------------------------------------- recognition

function Invoke-Recognize([string]$id, [string]$mode, [string]$pcm64) {
  if (-not $modeGrammars.ContainsKey($mode)) { Emit @{ t = 'result'; id = $id; ok = $false; error = 'bad mode' }; return }
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $bytes = [Convert]::FromBase64String($pcm64)
    $ms = New-Object System.IO.MemoryStream (, $bytes)
    Set-GrammarMode $mode
    $engine.SetInputToAudioStream($ms, $fmt)
    $r = $engine.Recognize()
    $engine.SetInputToNull()
    $ms.Dispose()
    $elapsed = $started.ElapsedMilliseconds
    if ($null -eq $r) {
      Emit @{ t = 'result'; id = $id; ok = $true; mode = $mode; text = $null; ms = $elapsed }
      return
    }
    $alts = @()
    foreach ($a in $r.Alternates) {
      if ($a.Text -ne $r.Text) { $alts += @{ text = $a.Text; confidence = [math]::Round($a.Confidence, 3) } }
    }
    Emit @{
      t = 'result'; id = $id; ok = $true; mode = $mode; text = $r.Text
      confidence = [math]::Round($r.Confidence, 3); grammar = $r.Grammar.Name; alternates = $alts; ms = $elapsed
    }
  } catch {
    try { $engine.SetInputToNull() } catch {}
    Emit @{ t = 'result'; id = $id; ok = $false; error = $_.Exception.Message }
  }
}

# ------------------------------------------------------------------- control

function Handle-Control([string]$line) {
  try { $msg = $json.DeserializeObject($line) } catch { Emit @{ t = 'log'; msg = 'bad control json' }; return }
  if ($msg -isnot [System.Collections.Generic.Dictionary[string, object]]) { return }
  switch ([string]$msg['cmd']) {
    'recognize' { Invoke-Recognize ([string]$msg['id']) ([string]$msg['mode']) ([string]$msg['pcm']) }
    'grammar' {
      if ($msg.ContainsKey('wakeWords')) { $state.wakeWords = Clean-List $msg['wakeWords'] $state.wakeWords }
      if ($msg.ContainsKey('phrases')) { $state.phrases = Clean-List $msg['phrases'] @() }
      if ($msg.ContainsKey('dictationPrefixes')) { $state.prefixes = Clean-List $msg['dictationPrefixes'] @() }
      try { Build-Grammars } catch { Emit @{ t = 'error'; msg = "grammar: $($_.Exception.Message)" } }
    }
    'speak' {
      $text = [string]$msg['text']
      if ([string]::IsNullOrWhiteSpace($text)) { return }
      if ($text.Length -gt 400) { $text = $text.Substring(0, 400) }
      try {
        $synth.SpeakAsyncCancelAll()
        $voice = [string]$msg['voice']
        if ($voice) { try { $synth.SelectVoice($voice) } catch { Emit @{ t = 'log'; msg = "voice not found: $voice" } } }
        if ($msg.ContainsKey('rate')) { $synth.Rate = [math]::Max(-10, [math]::Min(10, [int]$msg['rate'])) }
        if ($msg.ContainsKey('volume')) { $synth.Volume = [math]::Max(0, [math]::Min(100, [int]$msg['volume'])) }
        [void]$synth.SpeakAsync($text)
      } catch { Emit @{ t = 'log'; msg = "tts: $($_.Exception.Message)" } }
    }
    'stopSpeaking' { try { $synth.SpeakAsyncCancelAll() } catch {} }
    'ping' { Emit @{ t = 'pong' } }
    'shutdown' { $state.quit = $true }
  }
}

# ---------------------------------------------------------------------- main

try { Build-Grammars } catch { Emit @{ t = 'fatal'; msg = "grammar: $($_.Exception.Message)" }; exit 1 }
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
Emit @{ t = 'ready'; recognizer = $info.Name; voices = $voices; pid = $PID }

# [Console]::In.ReadLineAsync() blocks (synchronized reader); a StreamReader is truly async.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
$pending = $stdin.ReadLineAsync()
$wasSpeaking = $false
while (-not $state.quit) {
  # Synthesizer state is polled (a property read every 30 ms) rather than wiring
  # SAPI events into this runspace.
  $speaking = $synth.State -eq [System.Speech.Synthesis.SynthesizerState]::Speaking
  if ($speaking -ne $wasSpeaking) { Emit @{ t = $(if ($speaking) { 'tts_start' } else { 'tts_end' }) }; $wasSpeaking = $speaking }
  while ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { $state.quit = $true; break }   # parent closed stdin -> exit
    if ($line.Length -gt 0) { Handle-Control $line }
    $pending = $stdin.ReadLineAsync()
  }
  if (-not $state.quit) { Start-Sleep -Milliseconds 60 }
}

try { $synth.SpeakAsyncCancelAll(); $synth.Dispose() } catch {}
try { $engine.Dispose() } catch {}
exit 0
