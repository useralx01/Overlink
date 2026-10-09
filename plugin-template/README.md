# Relay plugin template

Use this after registering **your own** ChatGPT app for your Relay deployment. This template contains no account-specific app registration.

1. Copy `.app.example.json` to `.app.json` and replace `YOUR_REGISTERED_APP_ID` with your app's registered ID.
2. Copy `../assets/brand/pc-link-icon.png` into `assets/pc-link-icon.png` within this folder.
3. Package the contents of this folder as a ZIP so `.codex-plugin/plugin.json`, `.app.json`, and `assets/pc-link-icon.png` are at the ZIP root.
4. Import or upload the package through the plugin interface available to your account.

The correct cyan chain image is referenced by `interface.logo` and `interface.composerIcon`. The ChatGPT cloud listing may use its own fallback icon; this template does not promise to override that platform behavior.
