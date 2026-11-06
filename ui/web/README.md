# BotCube Web UI

This package is a runnable white-label chat app. Build it with:

```bash
pnpm --filter botcube-ui-web build
```

The standalone static export is written to `.next-standalone/`. A cartridge
build uses `.next-cartridge/`, keeping the two build graphs isolated. Set
`NEXT_PUBLIC_CHAT_SERVICE_URL` to the
public Chat Service origin:

```bash
NEXT_PUBLIC_CHAT_SERVICE_URL=https://api.example.com
```

Without a cartridge alias, neutral defaults connect to a local Chat Service at
`http://localhost:8123`.
