# Phone Sentinel (`@toxicwind/phone-sentinel`)

Zero-touch, network-reactive ADB sentinel for Chris's Pixel 9 Pro XL on LAN and Tailscale.

<div align="right">

[![runtime: bun 1.4](https://img.shields.io/badge/runtime-Bun_1.4-fbf0df?style=for-the-badge&logo=bun)](https://bun.sh)
[![managed by: pitchfork](https://img.shields.io/badge/managed_by-pitchfork-22c55e?style=for-the-badge)](https://pitchfork.jdx.dev)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

Phones disconnect and reconnect to Wi-Fi constantly, dropping ADB sessions and rotating TLS ports. `phone-sentinel` runs as a high-frequency, non-blocking background supervisor that:
1. Detects dropped connections reactively without polling delays.
2. Concurrent-scans open ports across both LAN (`10.0.0.77`) and Tailscale (`100.123.57.58`).
3. Probes the raw `STLS`/`CNXN` protocol on candidate sockets to distinguish wireless debugging from pairing endpoints.
4. Auto-reconnects and publishes live health & telemetry over HTTP (`:25178/health`).

## Architecture

- **Runtime**: Bun 1.4 (Pure TypeScript, native async sockets)
- **Service Management**: Pitchfork daemon (`daemons.phone-sentinel`) + `mise` task runner
- **Port**: `25178` (`/health` and `/status` JSON endpoints)

## Quick Start

```bash
# Run with mise
mise run start

# Inspect status
mise run status

# Or run directly via Bun
bun run src/index.ts
```

## Pitchfork Integration

```toml
[daemons.phone-sentinel]
description = "Network-reactive ADB sentinel for Pixel 9 Pro XL"
run = "bun run src/index.ts"
dir = "/home/toxic/phone-sentinel"
port = 25178
ready_http = "http://127.0.0.1:25178/health"
health_http = { url = "http://127.0.0.1:25178/health", interval = "15s", timeout = "3s" }
restart = "always"
restart_delay = "5s"
```
