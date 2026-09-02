# zcode-claw-adapter

A [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) custom
engine that lets Claw own orchestration while [ZCode](https://z.ai) owns the
coding session. The adapter translates Claw stream-json messages to the ZCode
Protocol over `zcode app-server --stdio` and preserves the real ZCode
`sess_...` session ID end-to-end (announced in the init event and stored under
the state dir, so a stopped or crashed session can be resumed with
`--resume`).

## Install

```bash
npm install -g @bwndlct/zcode-claw-adapter
```

Requires Node.js >= 22 and a ZCode installation.

## Verified scope

The current release has been verified on **macOS** against **ZCode Desktop and
ZCode CLI 0.16.5**. It has not been verified on Linux, Windows, or other ZCode
versions. Platform-specific behavior (for example the macOS desktop
session-list refresh via `zcode://` deeplink) degrades gracefully elsewhere.

## Authentication

The adapter never reads, logs, or persists credential values; the model
provider registry it pushes to the ZCode child references an **environment
variable name**, not a value.

- Primary entry: export `ZCODE_APPSERVER_KEY=<api key>` (override the variable
  name with `--api-key-env`).
- Optional convenience: when `ZCODE_APPSERVER_KEY` is unset, the CLI reads the
  first enabled Z.AI provider key from the local ZCode Desktop config
  (`~/.zcode/v2/config.json`, or `$ZCODE_DESKTOP_CONFIG`). This is a fallback,
  not a requirement.
- Opaque alternative: pass a full provider registry JSON on an inherited file
  descriptor with `--registry-fd <n>`; bytes are forwarded to the child
  byte-for-byte and never logged.

## ZCode binary discovery

Order: `--zcode-bin <path>` → `$ZCODE_BIN` → `zcode` on `PATH` →
`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (macOS).

## Usage

```bash
zcode-claw-adapter --help
zcode-claw-adapter --version
```

The engine speaks Claude-Code-style stream-json on stdin/stdout, which is what
Claw's `customEngine` spawns in persistent mode. Engine options include:

- `--workspace <dir>` — workspace for ZCode sessions (default: cwd)
- `--state-dir <dir>` — adapter state dir (default: `~/.local/state/zcode-claw`)
- `--resume <sessionId>` — resume a ZCode session by its real `sess_...` id
- `--model <provider/model>` — default `z/GLM-5.3`; `--base-url` overrides the
  provider endpoint
- `--mode plan|build|edit|yolo` — ZCode permission mode; `--readonly` is a
  shorthand for plan + deny-all permission answers
- `--max-tool-concurrency <N>` — forwarded verbatim to the zcode child's
  native `ZCODE_MAX_TOOL_CONCURRENCY` env var (throttles all parallel tool
  calls, not only sub-agent spawns, as of zcode 0.16.5)
- `--zcode-arg <arg>` — extra args passed to the zcode child (repeatable)
- `--event-log <file>` — append redacted protocol events for diagnostics

Run `zcode-claw-adapter --help` for the full list.

### Claw configuration

With Claw >= 6.3.0 you can reference the adapter as a community engine preset;
the preset lives upstream in `Enderfga/claw-orchestrator`
(`configs/engines/zcode.json`). For per-task control you can also inline a
custom engine:

```json
{
  "customEngine": {
    "engine": {
      "name": "zcode",
      "bin": "zcode-claw-adapter",
      "binEnv": "ZCODE_CLAW_ADAPTER_BIN",
      "persistent": true,
      "args": {}
    }
  }
}
```

Claw flags that reach the engine are mapped by the adapter's own argument
parser; unmapped flags fail fast with a non-sensitive error message.

## Troubleshooting

- **`zcode app-server exited unexpectedly`** — the ZCode child died. The real
  session ID is preserved in the state dir; relaunch with `--resume`.
- **`no credential found ... ZCODE_APPSERVER_KEY`** — set the key explicitly
  or verify the ZCode Desktop config fallback path.
- **resume failed: not found** — ZCode persists a session durably only after
  its first completed turn; a session killed before that is not resumable.
- `--event-log <file>` records redacted protocol traffic (capped at 64 MB) to
  diagnose protocol-level issues.

## Development

```bash
npm run check      # syntax check
npm test           # unit + fake-app-server integration tests
npm run install:local   # deploy the adapter files to ~/.local/share/zcode-claw/adapter
```

Edit this repository as the source of truth, then rerun
`npm run install:local`; do not maintain the installed copy directly.

## License

[MIT](./LICENSE)
