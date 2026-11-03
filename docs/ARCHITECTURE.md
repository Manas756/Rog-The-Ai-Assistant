# ROG architecture

This document explains how ROG works, subsystem by subsystem, with the source
files and functions to read. "Implemented" means it exists and is exercised by
tests or was run on this machine; "Extension" means a designed-for but not built
capability.

```
┌──────────────────────────── Electron main process (Node) ────────────────────────────┐
│                                                                                        │
│  index.ts ── lifecycle, IPC (validated), tray, shortcuts, permissions                  │
│     │                                                                                  │
│     ├── Assistant (assistant/orchestrator.ts) ◄── owns the StateMachine               │
│     │      │  onAudioFrame ─► Vad ─► utterance ─► SpeechHost.recognize(mode)           │
│     │      │  result ─► interpretLocally ─► (interpretWithLlm) ─► expandWorkflows      │
│     │      │  ─► assessPlan (policy) ─► [CONFIRMING] ─► executePlan ─► Launcher        │
│     │      └─ speaks via SpeechHost.speak                                              │
│     │                                                                                  │
│     ├── SpeechHost (assistant/speechHost.ts) ──stdin/stdout JSON──┐                   │
│     ├── SettingsStore / CommandStore / SecretStore (storage/)     │                   │
│     └── Launcher (platform/launcher.ts) ─► spawn(exe, args, {shell:false})            │
│                                                                    │                   │
└──────────────▲───────────────────────────────▲─────────────────────┼──────────────────┘
               │ contextBridge (preload/orb.ts)│ preload/settings.ts │
┌──────────────┴──────────────┐  ┌─────────────┴────────────┐  ┌─────▼─────────────────────┐
│ Orb renderer (sandboxed)    │  │ Settings renderer        │  │ powershell.exe            │
│ OrbRenderer (Canvas 2D)     │  │ (sandboxed, on demand)   │  │ resources/speech/         │
│ MicCapture + AudioWorklet   │  │                          │  │   speech-host.ps1         │
│ status bubble               │  │                          │  │ System.Speech (SAPI)      │
└─────────────────────────────┘  └──────────────────────────┘  └───────────────────────────┘
```

Framework choice: **Electron + TypeScript**, bundled with esbuild. Tauri would use
less RAM (~40–60 MB vs ~150 MB) but needs the Rust toolchain and MSVC build
tools, which aren't installed. Electron provides reliable transparent,
click-through, always-on-top windows on Windows, Web Audio and Canvas, and
mature process APIs. No UI framework: the orb is a canvas and the settings
window is ~900 lines of plain DOM code, so React would add weight without
removing complexity.

---

## A. Desktop window

**Files:** `src/main/windows.ts` (`createOrbWindow`, `orbBounds`), `src/renderer/orb/main.ts` (pointer handling).

- **Floating and transparent.** The orb window is `frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false`. The page body is transparent, so only canvas pixels are visible.
- **Top center.** `orbBounds()` takes the primary display's *work area* (excluding the taskbar), centers a 400×172 window horizontally and adds the user's saved offset. The orb is drawn 36 px from the top, so its 52 px body starts ~10 px below the screen edge. The extra window area gives waves and the status line room to draw. `screen` `display-metrics-changed` / `display-added` / `display-removed` re-run the placement.
- **Never steals focus.** `focusable: false` means Windows never activates the window: clicks on the orb and every animation leave keyboard focus in your editor. The window is shown with `showInactive()`. `skipTaskbar: true` keeps it out of Alt-Tab and the taskbar.
- **Click-through except the orb.** `setIgnoreMouseEvents(true, { forward: true })` passes clicks to the windows underneath while still forwarding `mousemove` to the page. The renderer hit-tests the orb circle (27 px) and the confirmation chips, and asks main (`orb:interactive`) to capture the mouse only while the pointer is over them.
- **Interactions.** Click = push-to-talk; drag = move (screen-space deltas sent over `orb:drag`, saved as an offset on `orb:drag-end`); right-click = the tray menu as a popup.
- **Always on top** uses the `screen-saver` level so the orb stays above maximized windows. It can be turned off in Settings.
- **Tray** (`src/main/tray.ts`): push-to-talk, microphone on/off, voice on/off, show/hide orb, reset position, launch at sign-in, settings, quit. The menu is rebuilt on every state change so its label and checkboxes stay accurate. Hiding the orb hides the window; the assistant and microphone keep running.
- **Settings window** is created on demand and *destroyed* on close (~40 MB freed) rather than hidden.

## B. Graphics and animations

**Files:** `src/renderer/orb/orbRenderer.ts` (drawing), `src/renderer/orb/theme.ts` (all tunables).

**Technology:** Canvas 2D. A WebGL shader could do real ray-marched lensing,
but at 52 px a handful of gradients and strokes reads the same, costs far less
GPU, and stays easy to tweak. Each frame redraws ~10 gradient fills, about 15
strokes and roughly 30 particle dots.

**The black hole, back to front:**

1. *Glow:* a radial gradient in gold to bronze to transparent, alpha ≤ 0.16. Deliberately restrained.
2. *Gravitational shadow:* a black radial gradient just outside the core, darkening whatever is behind it.
3. *Far half of the accretion disk:* four thin ellipses (`diskSquash` 0.26, slight tilt), drawn from π to 2π. They share one conic gradient whose bright side and dim side imitate relativistic Doppler beaming; the gradient's start angle rotates over time, so the gold appears to flow. The inner ellipse is the brightest and thickest, falling off outward.
4. *Core:* a near-black radial fill (#000 to #0b0906 at the rim), contracted briefly on wake.
5. *Photon ring:* a 0.9 px circle with a vertical gradient (champagne at the top). The *lensed arcs* are a brighter arc over the top and a faint arc underneath: the far side of the disk bent around the core, which is what makes it read as a black hole rather than a planet with rings.
6. *Near half of the disk* (0 to π) is drawn **over** the core.
7. *Particles* live in disk coordinates `(theta, r)` and are projected through the same squash and tilt. Their angular velocity is Keplerian (`flow * (r_inner / r)^1.5`), so inner particles orbit faster. Radial drift is driven by the state's `inward` value: positive values spiral them into the core (absorbing), negative values push them out (emitting). Particles on the far side are hidden behind the core.

**State-driven animation:** `theme.ts › STATE_TARGETS` gives every state a
target profile: `ring, glow, scale, flow, inward, particles, wave, spin, ember,
mute, breathe`. Every frame, each current value moves toward its target with
frame-rate-independent exponential smoothing:

```
cur += (target - cur) * (1 - exp(-rate * dt))
```

Any state can therefore follow any other with a smooth transition and no
hand-written tweens. On top of that, `onEnter(state)` fires short one-shot
effects from `EFFECTS`:

| State | What you see | How |
|---|---|---|
| IDLE | small, calm, slow flow, slow breathing | low `flow`, `breathe` 0.5, 15 fps |
| WAKE_DETECTED | core contracts, ring brightens, two gravitational waves expand | `coreKick` impulse (fast in, eased out over 320 ms) + 2 staggered expanding circles + `scale` 1.14 |
| LISTENING | delicate golden waves around the orb | audio waveform (below) |
| PROCESSING | waves collapse inward, particles spiral in, two rotating arcs | `wave`→0 (shrinks the waveform radius as it fades), `inward` 1, `spin` 1, a ring collapsing onto the core |
| CONFIRMING | slow breathing, chips under the orb | `breathe` 1 |
| EXECUTING | thin golden wave radiates out, sparks stream out of the orb, particles emitted | expanding circle + 14 spark streaks biased downward toward the status line + `inward` −0.6 |
| SUCCESS | a ring contracts gracefully onto the photon ring | a contracting pulse with `sin(πt)` alpha |
| ERROR | restrained ember tint, one soft pulse | `ember` 1 mixes gold toward #c45c3a |
| MUTED | graphite and dim, no mic dot | `mute` 1 mixes toward graphite, 12 fps |

**Audio waveform (real):** while `wave > 0`, the renderer calls `MicCapture.read()`,
which reads the `AnalyserNode` on the actual microphone stream:

- `level`: time-domain RMS mapped from −50…−12 dBFS to 0…1
- `bands[6]`: peak magnitude in six log-spaced FFT ranges (about 125 Hz – 4 kHz)

The renderer smooths these with a fast attack and slow release. It then draws
two closed curves, `r(θ) = base + level·3 + d(θ)·amp`, where `d` sums six sine
ripples of orders 3–8. Each ripple's amplitude is one speech band and its phase
advances faster when you are louder. Silence gives a nearly circular ring;
speech makes it ripple. Nothing in the waveform is random.

**What is real versus decorative:** the waveform shape and size, and the
listening mic dot, reflect real signals. Particles, flow, pulses and sparks
are decorative, but every one of them is triggered by a real state transition:
EXECUTING only starts when the action executor begins, and SUCCESS only after
the launch result comes back.

**Performance controls:**
- Frame rate adapts: 60 fps while anything is animating or still easing; IDLE drops to **15 fps** and MUTED to **6 fps**. The idle motion is slow, so 15 fps looks continuous.
- No `desynchronized` canvas: on Windows that low-latency mode made the GPU process work ~6× harder to composite the transparent window (measured 32 % → 5 % of a core after removing it). Below 60 fps the loop schedules with `setTimeout` and then `requestAnimationFrame`, so the compositor isn't woken 60 times a second.
- Rendering stops completely when the page is hidden (`visibilitychange`).
- The canvas DPR is capped at 2.
- **Reduced motion** (`prefers-reduced-motion` or Settings): 6 fps, no particle motion, sparks, pulses or ripples. State changes still show through brightness, scale and tint.

## C. Audio pipeline

> **Update: Whisper.** Real-voice testing showed the Windows engine mishears natural
> speech (it was tuned on synthetic voices in early tests). Commands and yes/no are
> now transcribed by Whisper base.en (`src/main/asr/whisperWorker.ts`, an Electron
> utility process running transformers.js on Microsoft-signed ONNX Runtime with
> DirectML). `src/main/assistant/recognizer.ts` (`HybridRecognizer`) routes each
> utterance: Windows grammar first for the wake word, Whisper double-check for
> short or half-matched segments (`splitWake`: "rog" and sound-alikes like "raj"),
> Whisper (or optional cloud STT) for commands. Whisper gets a vocabulary prompt
> (`buildVocabularyPrompt`) as `<|startofprev|>` context. Utterances are
> level-normalized (`normalizeLevel`), and silence hallucinations ("you",
> "thank you", echoed prompt) are discarded. Chromium AGC is back **on**: with it
> off, real speech arrived nearly silent.


**Files:** `src/renderer/orb/micCapture.ts`, `pcmWorklet.ts`, `src/main/assistant/vad.ts`, `speechHost.ts`, `resources/speech/speech-host.ps1`.

```
mic ─ getUserMedia(deviceId, echoCancellation, noiseSuppression, AGC)
    ─ AudioContext(16 kHz) ─┬─ AnalyserNode (fft 256) ─► visualizer (stays in renderer)
                            └─ AudioWorklet "rog-pcm": float → int16, 640-sample (40 ms) frames
                                 ─ postMessage (transfer) ─ ipcRenderer.send('orb:audio') ─►
main: toInt16 (validates size) ─ Assistant.onAudioFrame ─ Vad.push
    speech_end (an utterance, 0.2–10 s) ─► SpeechHost.recognize(pcm, mode)
        ─ JSON line {cmd:'recognize', mode, pcm: base64} ─► powershell speech-host.ps1
            MemoryStream ─ SpeechRecognitionEngine.SetInputToAudioStream ─ Recognize()
        ◄─ {t:'result', text, confidence, grammar, alternates, ms}
```

- **Buffers.** Chromium resamples the device (usually 48 kHz) to 16 kHz properly, so no hand-written decimation is needed. The worklet fills a 640-sample `Int16Array` and transfers its buffer, so nothing is copied. Main receives 25 frames a second (32 KB/s). The VAD keeps a 300 ms pre-roll ring so the start of the first word isn't cut off.
- **VAD (`vad.ts`)** is energy-based with an adaptive noise floor (an EMA updated while nobody is speaking, and raised to the median level of any segment that hits the length cap, so continuous music or a TV is learned as background), a start threshold of `max(abs_min, floor × ratio)` set by the sensitivity slider, hysteresis (it is easier to keep speaking than to start), two frames to confirm onset, a 160 ms minimum of speech (clicks are discarded), and a 10 s maximum. The end-of-utterance silence is 380 ms in wake mode, 600 ms for commands and 450 ms for yes/no. Audio keeps flowing into the VAD while the previous segment is being recognized and across the WAKE_DETECTED → LISTENING transition, so a command spoken right after “rog” isn't clipped (an early build dropped those frames; found and fixed with the voice e2e test).
- **Wake word, two stages.** Stage A is the VAD, which costs a few hundred multiply-adds per frame and runs continuously. Only when an utterance ends does the speech engine run, against a **tiny grammar**: `rog | rogue | hey rog | okay rog`, plus a *filler* grammar of ~70 common words that absorbs ordinary speech. If the best match is the filler grammar, the utterance wasn't addressed to ROG. Stage B, the command grammar plus dictation, is enabled only after a wake word or push-to-talk. One-shot grammars (`rog <command>` and `rog search youtube for <dictation>`) let you say everything in one breath. Nothing expensive runs while you're silent.
- **AGC is off** in `getUserMedia`. Chromium's automatic gain control boosted room noise during pauses until it looked like speech; this was found by recording real segments on this PC (`ROG_DEBUG_AUDIO=1`) and fixed. Echo cancellation and noise suppression stay on. Wake-mode segments are capped at 4 s.
- **Why the Windows engine, and why per utterance.** It is offline, already installed (`MS-1033-80-DESK`), free, and grammar-constrained recognition is accurate and fast (6–120 ms per utterance on this machine). openWakeWord has no "ROG" model, and training one needs a heavy pipeline. whisper.cpp or faster-whisper would need a model download and 300 MB–1 GB of RAM, and the machine had ~2.6 GB free. SAPI needs a *seekable* input stream, so instead of streaming continuously, ROG hands it each finished utterance as a `MemoryStream`. That is also why idle CPU in the speech process is near zero.
- **Why PowerShell.** A compiled C# helper was built first, but **Smart App Control blocked the unsigned executable**. Rather than weaken that protection, the host runs as a script on Microsoft-signed components (`powershell.exe` plus `System.Speech`). Your execution policy (`RemoteSigned`) allows local scripts, so no policy override is used.
- **Thresholds live in main, not the host.** The host reports `text`, `confidence`, `grammar` and `alternates`; `Assistant.onRecognition` decides. The wake threshold is `0.85 − 0.4 × sensitivity` (0.61 at the default sensitivity of 0.6). Command grammar results are accepted at ≥ 0.25 and dictation at ≥ 0.1, with alternates tried in order by the interpreter. **Guess pass:** if a command segment is rejected, the same PCM is recognized again in `guess` mode (dictation only) and the fuzzy matcher picks the closest command. A `wake_dictation` grammar (`rog <anything>`) allows free one-shots; if they don't map to anything, ROG returns to idle silently.
- **TTS:** `SpeechSynthesizer.SpeakAsync` with the configured voice, rate and volume. The host polls `synth.State` and emits `tts_start` / `tts_end`. While ROG is speaking, plus 450 ms afterwards, microphone frames are ignored so it doesn't hear itself; Chromium's echo cancellation helps too.
- **No microphone.** `getUserMedia` errors are mapped to readable messages (blocked by Windows privacy settings, not found, in use). The orb goes to MUTED with that message, typed commands in Settings keep working, and push-to-talk tries to reopen the mic. If the speech host crashes, it is restarted up to three times per minute; after that, voice control pauses and the error appears in Settings.

## D. Command interpretation and routing

**Files:** `src/main/intent/localInterpreter.ts`, `llmInterpreter.ts`, `src/shared/schemas.ts`, `src/main/actions/*`, `src/main/workflows/leetcodeMode.ts`, `src/main/storage/stores.ts`.

1. **Normalize** (`shared/text.ts`): lowercase, fold spoken forms ("leet code" becomes `leetcode`, "c plus plus" becomes `c++`, "rocket chat" becomes `rocketchat`), strip the wake word and politeness.
2. **Local rules (Mode A),** in order: (a) trigger phrases of enabled commands, scored by the max of `similarity()` (edit distance plus word overlap) and `containment()` (every trigger word appears in order: 0.7 + 0.25 × trigger-length / sentence-length); ≥ 0.80 runs directly and 0.62–0.80 becomes a *did-you-mean* confirmation. Shutdown and restart require ≥ 0.97. (b) Search templates. (c) "open/launch/go to X", resolved against projects, sites, approved apps, detected browsers and editors. Two near-equal targets lead to a clarification.
3. **Optional LLM (Mode B),** only if the local rules return *unknown* **and** the user enabled it. It gets the action catalog plus your site, app and project ids, and must answer with JSON that matches a JSON schema (`output_config.format`). That JSON is parsed again with the **same zod `actionListSchema`** as user commands. The model can't name an app or project id that isn't in the list (it's an enum in the schema), and can't express anything outside the catalog.
4. **Structured commands.** Everything becomes a `Plan { label, actions: Action[], response?, source, confidence }`. `Action` is a discriminated union of nine types; nothing else can exist.
5. **Workflows** (`expandWorkflows`) replace `{type:'workflow', workflowId:'leetcode'}` with plain actions built from settings, *before* policy, so policy sees exactly what will run.
6. **Policy** (`assessPlan`): it re-validates the plan, then each action's `risk()` returns `safe | confirm | deny`. Unknown app or project ids are denied. A folder outside your projects needs confirmation. LLM plans need confirmation by default, and an executable launched from an LLM plan always does. More than six steps needs confirmation.
7. **Executor** (`executePlan`) runs actions sequentially with a 15 s timeout per step, stops at the first failure, honors cancellation, and reports each step. The bubble shows "Opening LeetCode…" while that step runs.
8. **Registry** (`actions/registry.ts`): each action type maps to `{describe, risk, run}`. TypeScript's mapped type forces every catalog entry to have an implementation.
9. **Custom commands** are stored in `%APPDATA%\ROG\commands.json` (`{version:1, commands:[…]}`), validated on load and on every save, and written atomically. A broken file is backed up and defaults are restored. **Imports** are validated, clashing ids are renamed, and imported commands are **disabled** until you enable them. Nothing executes during import.
10. **Ambiguity:** near-misses and near-equal targets go to CONFIRMING ("Did you mean LeetCode mode?"). You can answer yes or no by voice or click the chips; after 8 s it cancels. Unrecognized speech gets one "Say that again?" retry before an error.

## E. Windows integration

**Files:** `src/main/platform/detect.ts`, `launcher.ts`.

- **Brave detection:** checks `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` for `BraveSoftware\Brave-Browser\Application\brave.exe`, then the `App Paths\brave.exe` registry key (`reg.exe query`). A custom path from Settings overrides both. Every candidate is checked with `existsSync`. On this machine Brave was found at `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`. Chrome, Edge, Firefox, VS Code and Cursor are detected the same way. Note that `code` on your PATH points to Cursor, so editors are found by executable path rather than PATH.
- **Opening URLs:** the URL is parsed and re-serialized (`new URL().href`), then passed as `brave.exe [--new-window] -- <url>`. The `--` switch terminator means a crafted "URL" can never become a Chromium flag. "Windows default browser" uses `shell.openExternal`.
- **Starting processes:** `spawn(exe, args, { cwd, shell: false, detached: true, stdio: 'ignore' })`, so apps outlive ROG. Apps can carry fixed `args` and a `cwd`; SKlauncher, for example, is `javaw.exe -Xmx512M -jar SKlauncher.jar` in its own folder.
- **Store apps** (ChatGPT, WhatsApp, Terminal) have no launchable exe under `WindowsApps`. They're stored by AUMID (`Get-StartApps`) and opened with `explorer.exe shell:AppsFolder\<AUMID>`. The AUMID is validated by a strict regex before it's used.
- **Power:** the `power` action runs `%SystemRoot%\System32\shutdown.exe /s|/r /t <delay>` or `/a`. Policy denies it from AI plans; the interpreter requires a ≥ 0.97 match for shutdown/restart, otherwise it asks. Only absolute `.exe` paths that exist, from the approved list or detection results, can be launched.
- **What "success" means.** `started` means Windows created the process and reported a PID (spawn's `spawn` event). `requested` means the shell accepted the request (`openPath` / `openExternal`). ROG cannot know whether a web page finished loading. Brave hands a new URL to its already-running instance and the new process exits immediately, which is still a successful launch. Failures (missing exe, spawn `error`, Explorer error) are reported with the reason and spoken.
- **Folders:** `shell.openPath` only after `statSync().isDirectory()`. Explorer "opening" a *file* would run it, so files are refused.
- **Windows security effects:** Smart App Control blocked the unsigned compiled helper, which is why the helper is a script. Microphone access depends on *Settings › Privacy › Microphone › Let desktop apps access your microphone*. ROG runs with normal user rights and never asks for elevation.

## F. Security

See `docs/SECURITY.md` for the full model. The short version:

- **Arbitrary shell execution is dangerous** because speech recognition is error-prone and LLM output can be manipulated. A misheard "delete" or an injected instruction must not be able to reach `cmd.exe`. ROG has **no code path** from text to a shell: `shell: false`, no `exec`, no `.bat`, `.cmd` or `.ps1` launching, and actions limited to a typed catalog.
- **LLM containment:** schema-constrained output, then re-validation, policy, and confirmation by default.
- **IPC:** `contextIsolation`, `sandbox`, no `nodeIntegration`. Preloads expose ~25 narrow functions. Main checks the **sender** of every message (orb-only and settings-only channels) and validates every payload with zod. Renderers can't reach the network, because a `webRequest` filter allows only `file:`, `devtools:`, `data:` and `blob:`. CSP is `default-src 'none'`. Navigation and `window.open` are blocked. The only permission ever granted is audio capture, and only to ROG's own pages.
- **Secrets:** from `ROG_LLM_API_KEY` / `ANTHROPIC_API_KEY`, or stored encrypted with DPAPI (`safeStorage`) in `llm-key.bin`. A key is never sent to a renderer.

## G. Performance

Measurements are in the README's *Performance* section. The levers:

- **CPU:** the VAD is O(frame) arithmetic, and SAPI runs only per utterance. Rendering is 15 fps at idle, 6 fps when muted, and zero when hidden. No inference runs while you're silent. The speech host's control loop sleeps 60 ms between polls. Measured total at idle: ≈ 14 % of one core (see README).
- **Memory:** no UI framework; the settings window is destroyed on close; the bundled main process is one 1.3 MB file. The heaviest optional piece is the Anthropic SDK, which is only exercised when AI interpretation is on.
- **Audio:** 16 kHz mono int16 end to end, with no format conversions after the worklet. Frames are transferred, not copied, into IPC.
- **Profiling:** Settings › Diagnostics shows `app.getAppMetrics()` CPU and memory per Electron process. Run `npm run dev` for DevTools: use the Performance panel on the orb window and watch "Scripting" per frame. For the speech host: `Get-Process powershell | ? { $_.Id -eq <pid> }`.

## H. Extending ROG

- **New workflow:** add a builder like `buildLeetcodeActions` in `src/main/workflows/`, add its id to the `workflow` enum in `schemas.ts` and the catalog's options, and handle it in `expandWorkflows`.
- **New action type:** (1) add a variant to `actionSchema`, (2) add an entry to `ACTION_CATALOG` (UI fields), (3) implement `{describe, risk, run}` in `actions/registry.ts`. The compiler errors until all three exist. If it touches the OS, put the OS call behind `Launcher` so tests can mock it.
- **More apps:** Settings › Browser & apps › approve an `.exe`. It immediately becomes sayable ("open Spotify") because `buildGrammar` regenerates the vocabulary.
- **Another LLM provider:** add a `callX()` in `llmInterpreter.ts` that returns the JSON text, plus an option in the `provider` enum. Validation and policy are shared. An OpenAI-compatible path for local models (Ollama, LM Studio) already exists.
- **A better local recognizer:** implement the `SpeechPort` interface (`recognize(pcm, mode)`) with Vosk (grammar support, Apache-2.0, ~50 MB model) or whisper.cpp, and pass it to `Assistant` instead of `SpeechHost`. The VAD and everything downstream stay the same.
- **Visual changes:** almost everything is in `theme.ts`: palette, geometry, per-state targets, effect timings, frame rates. A WebGL lensing shader could replace `drawDisk` and the photon ring without touching the state logic.
