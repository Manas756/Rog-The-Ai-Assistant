# ROG

A tiny golden singularity that floats at the top center of your Windows desktop,
listens for **“ROG”**, and does what you ask: open sites and apps, start your
LeetCode session, open projects, search. It also runs commands you teach it.

- **Offline voice that understands you.** Commands are transcribed by **OpenAI Whisper running locally on your GPU** (~0.3 s), with the Windows engine as a cheap wake-word pre-check. No audio leaves the PC and no API key is needed. An optional cloud transcriber (e.g. Groq) can be switched on.
- **Real actions.** It launches Brave (or another browser), VS Code, Cursor, approved apps, project folders, and multi-step workflows.
- **Safe by construction.** Speech and AI output map to a typed catalog of actions. Nothing ever reaches a shell. See [docs/SECURITY.md](docs/SECURITY.md).
- **Unobtrusive.** About 52 px, click-through, never takes keyboard focus, 30 fps when idle.

How it works internally: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Requirements

- Windows 10/11 with the **English (US) speech recognizer**. It's present on most installs: check *Settings › Time & language › Speech*. ROG reports it if it's missing.
- Node.js 20+ (tested with 24) to build from source.
- A microphone, and *Settings › Privacy & security › Microphone › Let desktop apps access your microphone* turned on.

## Setup

```powershell
npm install
# npm 11 may skip Electron's download script; if node_modules\electron\dist is missing:
node node_modules/electron/install.js
npm run setup:whisper   # one-time: downloads the Whisper base.en model (~350 MB) into resources/models
npm start            # build + launch
npm run dev          # same, with DevTools and console logs
npm test             # 100 unit/integration tests (no apps are launched)
npm run typecheck
node scripts/run-voice-e2e.mjs   # real speech engine on synthesized speech, 8 scenarios (mock launcher)
```

On first launch the orb appears at the top center and the microphone opens.
Settings and commands live in `%APPDATA%\ROG\` (`settings.json`, `commands.json`).

## Using ROG

| Say | What happens |
|---|---|
| “ROG” … “start LeetCode mode” | Opens LeetCode and YouTube Music in Brave (configurable) |
| “ROG, open GitHub” (one breath works too) | Opens the site in your preferred browser |
| “ROG, search YouTube for graph algorithms” | YouTube search |
| “ROG, open Brave” / “open VS Code” | Starts the app |
| “ROG, open my Rocket.Chat project” | Opens the project folder in VS Code (add the project in Settings first) |
| “ROG, music” | YouTube Music |
| “ROG, shut down” / “restart” | Shuts down or restarts Windows after a 10 s countdown (built-in, **off by default**; enable it under Commands) |
| “ROG, cancel shutdown” | Aborts a pending shutdown or restart |
| “ROG, what command are you executing?” | Reports the current or last command |
| “ROG, mute yourself” / “unmute yourself” | Turns spoken responses off or on |
| “ROG, stop listening” | Closes the microphone (the orb turns graphite) |
| “ROG, hide yourself” | Hides the orb; bring it back from the tray |
| “ROG, what can you do?” | Short help |

**Without the wake word:** press **Ctrl+Alt+R** or click the orb, then speak (push-to-talk).
Press again to cancel. **Ctrl+Alt+M** toggles the microphone. Both shortcuts are configurable.
Right-click the orb for the menu; drag it to move it.

**Seeing what ROG is doing:**

| Orb | Meaning |
|---|---|
| Small, calm gold, faint dot below | Idle. Mic open, waiting for “ROG” |
| Ring brightens, waves expand | Wake word heard |
| Golden waves rippling | Listening. The waves follow your voice |
| Particles spiral in, arcs rotate, transcript shown | Understanding the request |
| Two chips under the orb | Waiting for “yes” or “no” |
| Thin wave outward + “Opening LeetCode…” | Launching |
| Ring contracts | Done |
| Ember tint + message | Something failed; the message says why |
| Graphite, no dot | Microphone off. ROG cannot hear you |

## How ROG guesses

You don't have to say trigger phrases word for word:

- “ROG, could you please open GitHub for me” works: politeness is stripped and the trigger is matched fuzzily, including by containment, where every word of a trigger appears in order.
- If the strict command grammar can't make sense of what you said, ROG listens to the **same audio again as free dictation** and guesses the closest command, instead of saying “didn't catch that”.
- “ROG <anything>” in one breath is accepted. If what follows means nothing to ROG, it quietly goes back to idle, so people saying “rogue…” nearby don't trigger errors.
- Close-but-unsure matches ask “Did you mean …?”. **Shut down and restart never guess**; they need the exact phrase.

## Teaching ROG commands

Settings › **Commands** › *New command*:

1. A **name**, and one or more **trigger phrases** (“start development mode”).
2. **Steps** picked from the approved catalog: open website, search, open app, open project, open folder, run workflow, say something, wait, control ROG.
3. An optional **spoken response**. Then **Save** and **Test**.

New phrases become recognizable immediately: ROG rebuilds its speech grammar
whenever commands, sites, apps or projects change. Commands can be exported and
imported as JSON. Imported commands start **disabled** until you review them.
See `config/examples/commands.example.json`.

## Apps: desktop and Microsoft Store

Settings › Browser & apps › *Approve an application* adds any `.exe`. You can
also add apps in `settings.json` under `apps`, either:

- `{ "id", "name", "path": "C:\…\App.exe", "args": [...], "cwd": "C:\…" }` for desktop
  apps. `args` and `cwd` cover launchers such as SKlauncher, which runs `javaw.exe -jar …`.
- `{ "id", "name", "aumid": "Publisher.App_hash!App" }` for **Store apps** such as ChatGPT,
  WhatsApp or Windows Terminal, which have no launchable .exe. Get the id with
  `Get-StartApps` in PowerShell. ROG opens them with `explorer.exe shell:AppsFolder\<id>`.

## Shutdown and restart

The **Shut down PC** and **Restart PC** commands run Windows' own
`shutdown.exe /s` or `/r` with a countdown (Settings › General, default 10 s, 0 for
none). Say **“ROG, cancel shutdown”** within the countdown to abort (`shutdown /a`).
To guard against mishearing, they run only on a near-exact match of a trigger
phrase; anything close asks “Did you mean…?”. They are never accepted from the
AI interpreter, and they ship disabled.

## LeetCode mode

Settings › **LeetCode mode**: the browser for LeetCode and, separately, for music
(e.g. LeetCode in Chrome where you're signed in, music in Brave), tabs vs. new window vs. separate windows,
LeetCode URL, YouTube Music URL, an optional **playlist URL**, optionally opening
a project in your editor, and the spoken response. Browsers block autoplay, so
YouTube Music opens but may need a click before music plays.

## Optional AI interpretation

Off by default. When enabled (Settings › **AI interpretation**), requests the local
rules don't understand are sent as **text** to Claude (default model
`claude-opus-5-5`; any Claude model id works) or to an OpenAI-compatible
endpoint such as a local Ollama. The model returns a plan of catalog actions,
which ROG validates and asks you to confirm before running. The key is read from
`ROG_LLM_API_KEY` or `ANTHROPIC_API_KEY`, or stored DPAPI-encrypted from the
Settings field. Requests to Claude use the API's server-side refusal fallback
(`fallbacks: "default"`), so a model refusal falls back to another model rather
than failing the command.

## Building an installer

```powershell
npm run dist:dir     # unpacked app in release\win-unpacked\ROG.exe (quick check)
npm run dist         # NSIS installer + portable .exe in release\
```

electron-builder downloads its NSIS and winCodeSign tools on first use. The
result is **unsigned**: Smart App Control or SmartScreen may block it on
other PCs. To distribute it, sign it with a code-signing certificate
(`CSC_LINK` / `CSC_KEY_PASSWORD` environment variables) or run it from source.

## Speech recognition

| Stage | Engine | Typical time here |
|---|---|---|
| "Is this for ROG?" | Windows grammar spotter, then Whisper for short segments it doesn't accept | 0.05–0.3 s |
| Your command | Whisper base.en on the RTX 4050 (DirectML), prompted with ROG + your command words | 0.2–0.4 s |
| Yes / no | Whisper | 0.2–0.3 s |

Whisper is given a **vocabulary prompt** built from your wake word, commands and
app names. Without it, Whisper wrote "Rog" as "Raj"; with it, "ROG". Each
utterance is volume-normalized (quiet speech boosted up to 16×) before recognition.

Settings › Voice: **Engine** (Whisper / Windows), **Run Whisper on** (GPU ≈ 0.3 s,
≈ 1.5 GB RAM; CPU ≈ 1.2 s, ≈ 0.76 GB), optional **cloud transcription** for commands
(any OpenAI-compatible `/audio/transcriptions` API, e.g. Groq with
`whisper-large-v3-turbo`; key from `GROQ_API_KEY` / `ROG_STT_API_KEY` or stored with DPAPI).

## Performance

Measured on this machine (i5-13450HX, RTX 4050, 16 logical cores), ROG idle with
the mic on and people talking in the room, over 30 s (`npm run measure`):

| Process | CPU (% of one core) | Private memory |
|---|---|---|
| Whisper (utility process, GPU) | 0.8 % | 1454 MB |
| GPU process (compositing the transparent orb) | 4.6 % | 79 MB |
| Orb renderer (canvas at 15 fps) | 4.2 % | 44 MB |
| Speech host (PowerShell + SAPI wake pre-check) | 0.6 % | 107 MB |
| Main + audio utility processes | 5.9 % | 79 MB |
| **Total** | **≈ 16 % of one core (≈ 1 % of the CPU)** | **≈ 1.76 GB** |

Use *Run Whisper on: CPU* to cut memory to ≈ 1 GB total at the cost of ≈ 1 s slower commands.

The first build used 51 % of a core at idle. Most of that was a `desynchronized`
canvas plus 30 fps compositing of the transparent window; both were fixed.
Recognition takes 6–120 ms per utterance. Opening the Settings window adds about
40–60 MB until you close it.

## Troubleshooting

| Problem | Fix |
|---|---|
| Orb is graphite with “Microphone blocked” | Windows Settings › Privacy & security › Microphone: enable *Let desktop apps access your microphone* |
| ROG never wakes | Settings › Voice: say “ROG” and watch *What ROG heard*. Raise **wake sensitivity** if the confidence is just under the threshold; raise **speech detection sensitivity** if nothing appears at all; pick the right microphone |
| ROG wakes by accident | Lower wake sensitivity, or turn off the wake word and use push-to-talk |
| “brave isn't installed or wasn't found” | Settings › Browser & apps › Brave › *Locate…* and choose `brave.exe` |
| Speech engine error in Settings | Check that the en-US speech recognizer is installed; check that `powershell.exe` can run local scripts (`Get-ExecutionPolicy` should be `RemoteSigned` or less strict) |
| Shortcut doesn't work | Another app owns it. Settings shows a warning; choose another combination |
| `npm install` didn't download Electron | Run `node node_modules/electron/install.js`. On a slow link you can set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` first; the installer verifies the official SHA-256 checksums either way |
| A shutdown started by mistake | Say “ROG, cancel shutdown”, or run `shutdown /a` |
| Recognition misbehaves in a noisy room | Run `npm run dev` with `ROG_DEBUG_AUDIO=1` to log what ROG heard and save the segments to `%APPDATA%\ROG\debug-audio` (opt-in diagnostics only; delete the folder afterwards) |

## Current limitations

- **Recognition**: Whisper base.en is English-only and occasionally mishears very short or mumbled commands. If that happens often, cloud transcription (Groq) uses the much larger whisper-large-v3 model.
- **Memory**: Whisper on the GPU holds ≈ 1.5 GB while ROG runs (DirectML overhead; the fp16 model variant is not loadable by the current ONNX Runtime).
- **Noisy rooms**: the VAD is energy-based. Loud music or a TV can merge with your voice into one segment. ROG learns continuous sound as background and the filler grammar rejects other people's speech, but it works best when you're the loudest thing near the mic.
- **The wake word** is grammar-spotted per utterance, not a neural keyword spotter. After a pause, ROG reacts about 0.5 s after you stop speaking, and very short or mumbled “ROG”s can be missed. Tune it with the sensitivity slider and the *What ROG heard* log.
- **Push-to-talk is press-to-start**, not hold-to-talk: Electron global shortcuts don't report key-up. ROG stops listening when you stop speaking.
- **Launch verification** stops at “the process started” or “Windows accepted the request”. ROG can't see whether a web page finished loading.
- **Music won't autoplay**: browsers require a user gesture.
- **Recognition uses the selected mic, but TTS uses the Windows default output.**
- The installer is **unsigned** (see above).
- Multi-monitor: the orb lives on the primary display.
