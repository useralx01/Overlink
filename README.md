<p align="center"><img src="assets/brand/pc-link-icon.png" alt="Relay cyan chain icon" width="96"></p>

# Relay

**Your PC. One conversation.**

![Relay — a desktop and phone connected by a glowing cyan link](assets/brand/pc-link-cover.png)

Relay connects ChatGPT to your own Windows computer: files, PowerShell, screenshots, browser automation, desktop input, window inspection, project tools, and local project memory. It includes the Windows controller, a hosted MCP backend, and the dashboard.

This repository is the source for **your own private deployment**. Each person deploys their own backend and registers their own ChatGPT app. It does not share the original developer's computer or account, and it does not transfer Codex usage to ChatGPT.

## What's included

| Component | Implementation |
| --- | --- |
| Windows controller | C# / .NET Framework, screenshots, UI Automation, mouse and keyboard |
| Terminal and files | PowerShell and a configured shared directory |
| Browser | Persistent Node.js / Playwright worker |
| Project tools | Git, TypeScript, Python language server |
| Memory and task journal | Local SQLite with search and audit records |
| External devices | Configured HTTP / MQTT connections |
| Hosted backend | Fetch-compatible Worker, SQLite/D1 and object storage |
| Dashboard | Responsive Relay interface and the cyan chain artwork |

## Build your Windows bundle

Requirements: Windows, .NET Framework 4 compiler, Node.js 22 or newer, and Python 3.11 or newer. The installer can install Python, Node.js and Git through winget if needed.

Clone or download this repository, then run from its root in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-windows.ps1 -Origin 'https://your-relay-host.example'
node scripts/build.mjs
node scripts/validate-artifact.mjs
```

The first command compiles `native/PCLink.cs`, `DesktopTools.cs` and `AgentBridge.cs`, embeds the Relay icon, and creates `assets/pc-link.zip`. The native controller's server origin is compiled from your `-Origin` argument. Use the exact HTTPS origin of your own deployment. The backend build embeds this ZIP, both brand images, the dashboard and the screenshot widget in `dist/server/index.js`.

The existing `PC Link` filenames and protocol identifiers remain compatible with the original controller. The public product name is Relay.

## Deploy and connect

1. Create your own hosted Worker / Sites deployment with a SQLite/D1 binding named `DB` and object-storage binding named `IMAGES`. Apply the SQL migrations in `drizzle/` in numbered order.
2. Set `PC_LINK_OWNER_EMAIL` to your ChatGPT login email and `PC_LINK_ORIGIN` to your deployment's HTTPS origin. Set separate random secrets for `PC_LINK_TRANSPORT_TOKEN` and `PC_LINK_SETUP_KEY` using the host's secret settings. `.env.example` lists the names; it is not a credential file.
3. Deploy `dist/server/index.js` as an ES module exporting `default.fetch`. `.openai/hosting.json` provides the generic Sites bindings; associate it with **your own** project using that platform's deployment workflow.
4. The host must authenticate the ChatGPT account and supply trusted `oai-authenticated-user-id` and `oai-authenticated-user-email` headers. The backend expects the Sites authentication gateway. Do not expose it directly with client-controlled identity headers. Other hosts require an authentication gateway that strips and replaces those headers.
5. Register your own ChatGPT app pointing at your deployment's `/mcp` endpoint, with the authentication/transport configuration required by your hosting gateway. Add it through the app/plugin connection interface available to your account. The `plugin-template/` folder documents the optional branding package and app-ID placeholder.
6. Download the Windows bundle from your deployment or extract `assets/pc-link.zip`, and run `agent/Start-PC-Link.cmd`. It installs the local dependencies and starts the controller. Select a shared folder and use the controller's pairing button to connect it to your deployment.
7. In ChatGPT, enable your app and request a computer list or screenshot. In the dashboard, verify that your computer is online.

The controller runs in your signed-in Windows session with a startup launcher; desktop interaction requires that session to be available. It is not a Windows service. Capability toggles, approval mode and device connections are configured in the controller. The exported controller retains its existing defaults: capabilities enabled and per-action approval disabled.

## Validate the source

```powershell
node --test tests/worker.test.mjs tests/screenshot-widget.test.mjs
python -m unittest discover -s tests -p '*_test.py'
```

The project tests require the Python dependencies and Node browser-agent dependencies to be installed. Install them in your own environment with `pip install -r agent/requirements.txt` and `npm ci --prefix agent`. For Playwright-managed browsers, run `npx --prefix agent playwright install chromium`.

## Current scope

Each deployment accepts one owner account. Public multi-account hosting is not implemented. Screenshot capture, storage, rendering and attachment are distinct steps; delivery into the model's visual input depends on the ChatGPT host supporting the widget upload/attachment path. The source tests use a mock host and do not prove that every ChatGPT mode receives image pixels.

This GitHub repository uses the correct Relay cyan chain icon and cover. The existing hosted ChatGPT plugin listing's folder fallback is a separate platform rendering issue.

No private app registration, device credentials, personal machine configuration or dependency caches are included.
