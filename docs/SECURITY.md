# Security and privacy

ROG listens to a microphone and starts programs, so it is built around one rule:
**text never becomes a command line.** Speech and AI output are interpreted into
a small typed catalog of actions, and only those actions can run.

## Threats considered

| Threat | Mitigation |
|---|---|
| Misheard speech triggers something harmful | No destructive actions exist in the catalog; uncertain matches ask "Did you mean…?"; failures stop the plan |
| Speech or AI output smuggles a shell command | No shell anywhere: `spawn(..., {shell:false})`, only existing `.exe` files from your approved list or detection; `.bat`/`.cmd`/`.ps1`/`.lnk` are not launchable |
| A crafted URL injects browser flags | URLs are parsed and re-serialized (`new URL().href`), restricted to http(s) without credentials, and passed after `--` |
| "Open folder" runs a file | Explorer is only given paths that `statSync` confirms are directories |
| LLM proposes something unexpected | JSON-schema-constrained output with enums for your app and project ids, re-validated by the same zod schema, policy-checked, and confirmation required by default (always for launching executables) |
| Imported command files | Validated as a whole (one bad action rejects the file); imported commands start **disabled**; nothing runs on import |
| Hand-edited or corrupted config | Validated on load; an invalid file is backed up as `*.broken-<time>` and defaults restored, never half-applied |
| Compromised renderer (XSS, malicious content) | Renderers load only local files, run sandboxed with context isolation and no Node, can't reach the network (request filter + CSP `default-src 'none'`), can't navigate or open windows, and talk to main through ~25 narrow functions that check the sender and validate every payload |
| Prototype pollution through settings patches | `deepMerge` drops `__proto__`, `constructor` and `prototype` keys (covered by a test) |
| Secret leakage | API keys come from environment variables or a DPAPI-encrypted file; never sent to renderers, never logged, never committed |

## Privacy defaults

- Speech recognition is **offline** (Windows speech engine). Audio never leaves the PC.
- Microphone audio is processed in memory and discarded. Nothing is recorded to disk.
- The microphone is **visibly** on: the orb shows a small dot only while the mic stream is open; MUTED (graphite orb, no dot) means the device is closed. Windows' own microphone indicator agrees, because closing releases the device.
- The AI interpreter is **off by default**. When on, it receives only the *text* of requests that local rules didn't understand, never audio.
- Launch at sign-in is **off** until you enable it.
- ROG never installs software, never reads browser data, cookies or passwords, never elevates privileges, and never disables Windows protections. Smart App Control blocked an unsigned helper during development; the design was changed to use Microsoft-signed components instead of working around it.

## Confirmation policy

| Plan | Behaviour |
|---|---|
| Opening approved websites, apps, projects; searches; ROG controls | Runs immediately |
| Opening a folder outside your configured projects | Asks first |
| Plans with more than 6 steps | Asks first |
| Plans from the AI interpreter | Asks first (setting, on by default) |
| Starting an executable from an AI plan | Always asks |
| Unknown app/project ids, invalid actions, unexpanded workflows | Refused |

## Accepted / residual risks

- Approved `.exe` files can be started with no confirmation, by design. Only approve programs you trust.
- `ROG_NO_DEVTOOLS=1` disables DevTools in the windows. They're enabled by default in this developer build.
- The speech host runs as `powershell.exe -NoProfile -NonInteractive -File speech-host.ps1`. Anyone who can modify that file can already run code as you; installed builds keep it under the app's resources folder.
