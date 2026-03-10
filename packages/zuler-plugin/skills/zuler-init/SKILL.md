---
name: zuler-init
description: Set up Zulip integration with zuler. Call this to check setup status, configure credentials, or get started with zuler.
---

Call the zuler `init` MCP tool to check setup status. If it's not available, help the user configure the zuler MCP server.

If credentials aren't configured, offer two options:
1. Spawn the zuler-onboarding agent as a teammate for guided setup
2. Manual setup: create a `.env` file with ZULIP_SITE, ZULIP_EMAIL, and ZULIP_API_KEY
