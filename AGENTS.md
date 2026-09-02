# Project Agent Instructions

- Read `.agent.memory.md` before reading or changing adapter code.
- Treat this repository as the adapter source of truth. Never maintain files under `~/.local/share/zcode-claw/adapter` directly.
- Never read, print, persist, or commit API keys, tokens, or credential values.
- Do not use synchronous filesystem or child-process APIs.
- After source changes, run `pnpm run check`, then `npm run install:local`, and verify the source and installed adapter directories match.
- Never create a Git commit or configure/push a remote without explicit user approval.
