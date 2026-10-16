# Overlink

**Every computer. Every AI. One connection.**

Overlink connects authorized Windows computers to ChatGPT and Codex through an authenticated MCP relay. It extends the original PC Link project with cross-PC context transfers, Codex session handoffs, diagnostics, guarded recovery, batched local workflows, and a latency dashboard.

> **Developer preview (v0.4.1).** This repository contains source code and self-hosting tools. It is not a publicly approved ChatGPT plugin or a general-purpose multi-tenant SaaS product.

## What it does

| Capability | Details |
| --- | --- |
| Remote PC control | Screenshots, Windows UI Automation, mouse/keyboard, terminal, files, browser automation |
| Multiple computers | Register/pair several devices for one authenticated owner |
| Device-to-device transfers | Send small text/context/file payloads through a queued relay; acknowledgments and expiry |
| Codex session handoff | Find a session and send a bounded recent JSONL context snapshot to another paired PC |
| PC diagnostics | RAM utilization, sampled CPU utilization, available disks, and top memory-consuming processes |
| Guarded recovery | Stop a specifically allowlisted process only after explicit local approval and identity checks |
| Efficient local execution | Bounded 24-step workflows, dependent operations, parallel reads, hash-verified patches, test runners |
| Code navigation | Local incremental SQLite FTS index, Git inspection, and language-server assistance |
| Browser batching | Combine up to six supported browser actions with a final snapshot |
| Observability | Task history, device status, and relay p50/p95 latency metrics |

An Overlink context handoff **does not migrate a running Codex process**, preserve its RAM state, or automatically execute transferred content. A computer that is shut down or has crashed cannot be remotely inspected by its software agent.

## Repository structure

```text
agent/                Local Python/Node helpers and safe Windows staging scripts
native/               Windows controller, file inbox, Codex reader, guarded recovery
worker/               Authenticated MCP / HTTPS relay and dashboard
db/                   Drizzle database schema
drizzle/              SQL migrations and migration journal
plugin-template/      Example plugin metadata (configure your own endpoint)
tests/                Server, agent, security and integration tests
scripts/              Build and artifact validation utilities
assets/brand/          Brand assets
```

## Build and test

For a Windows build, install Node.js 22+, Python 3.11+, Git, and the .NET Framework 4 compiler. From the repository root:

```powershell
npm ci
npm test
python -m unittest discover -s tests -p '*test.py'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 -Origin 'https://YOUR-PRIVATE-HOST'
npm run build
npm run validate
```

Browser tests require Playwright dependencies inside `agent/`:

```powershell
npm ci --prefix agent
node agent/browser.mjs --self-test
```

Use `agent/Start-Overlink.cmd` inside the compiled Windows bundle to stage the desktop agent. The installer stages into `%LOCALAPPDATA%\Overlink\app` without terminating a running legacy PC Link controller. It does **not** activate a second paired agent over an existing connection. Before a production cutover, finish in-flight commands and verify the relay is compatible.

## Self-hosting

The server is a Worker-style module intended for an authenticated environment with D1 `DB` and R2 `IMAGES` bindings. Do not deploy the raw Worker directly to the internet without an authenticated gateway.

1. Provision an HTTPS endpoint and database/object-storage bindings.
2. Set the required server-side environment variables using secure secrets management. See `.env.example`; never commit real values.
3. Apply the SQL migrations in `drizzle/` in numerical order. The `0003_overlink_transfers.sql` migration adds a transfer queue without dropping legacy tables.
4. Build the server with `npm run build`, then validate with `npm run validate`.
5. Build the Windows app using **your own HTTPS origin** and pair each device through the authenticated dashboard.
6. Register `/mcp` through the supported ChatGPT/Codex MCP integration for your host. Public plugin submission is a separate process.

The `PC_LINK_*` environment-variable names and older `/device/*` routes are retained for backward compatibility.

## Security and limitations

- **Single-owner design:** this source is not ready to host unrelated users under one deployment. Public distribution as a service requires proper per-tenant OAuth and access isolation.
- **No end-to-end encryption for the transfer queue:** transfer payloads may be readable in the backend database. Do not send passwords, API keys, confidential records, or unredacted session histories through this preview.
- **Explicit execution boundaries:** file/session transfers are data only. Sensitive operations require device permissions; process termination additionally requires local allowlisting and approval.
- **Safe retries:** use stable `request_id` values and review uncertain jobs before retrying. Never blindly replay destructive commands.
- **Device ownership:** only use Overlink with systems and accounts you control or have authorization to access.

See [SECURITY.md](SECURITY.md) before exposing the server to the internet.

## Project status

The private Windows integration has been tested on two paired machines, including remote desktop/tool calls and synthetic bidirectional file and session transfers. The published backend and desktop agent require environment-specific authentication and deployment; this GitHub repository by itself does not configure or grant access to any PC.

GitHub source is provided without a redistribution license at this stage. A license can be selected before inviting outside contributions.

---

Overlink builds on PC Link, keeping legacy code-path names where necessary to avoid breaking established clients.
