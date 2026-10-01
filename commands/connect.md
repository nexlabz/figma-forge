---
description: Check the bundled Figma MCP connection and walk through sign-in if needed
argument-hint: (no arguments)
---

Load the `figma-connect` skill and run the preflight now.

1. Call `mcp__plugin_figma_figma__whoami`.
2. If it succeeds, report: the Figma handle, every plan with its seat, and which plan you
   would use for writes (the first with a **Full** seat). Note any plan that is View-only.
3. If it fails, tell the user exactly how to connect — `/mcp` → **figma** → Authenticate —
   and stop there. Do not retry in a loop.

Keep the answer to a few lines. This is a status check, not a report.
