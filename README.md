# ZCode Claw Adapter

Local custom-engine adapter that lets Claw own orchestration while ZCode owns
the coding session. It translates Claw stream-json messages to ZCode Protocol
over `zcode app-server --stdio` and preserves the real ZCode `sess_...` ID.

## Layout

- `adapter/bin/zcode-engine-launcher.sh`: launcher and authorized credential passthrough.
- `adapter/bin/zcode-app-server.mjs`: Claw custom-engine protocol adapter.
- `adapter/lib/zcode-client.mjs`: ZCode Protocol stdio client.
- `adapter/lib/state.mjs`: local session bookkeeping for resume.
- `scripts/install-local.mjs`: per-file atomic installer for the local runtime copy.

## Local Installation

```bash
npm run check
npm run install:local
```

The installer deploys the four adapter files to:

```text
~/.local/share/zcode-claw/adapter
```

Edit this repository as the source of truth, then rerun `npm run install:local`.
Do not maintain the installed copy directly.
