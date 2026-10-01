---
name: figma-connect
description: "Connect and verify the Figma MCP server that ships with figma-forge. Load this BEFORE the first Figma tool call in a session, and whenever a Figma MCP call fails with an authentication, permission, seat, or rate-limit error. Triggers: 'connect figma', 'figma not connected', 'authenticate figma', 'figma mcp error', 'permission denied figma', 'which figma team', plus any 401/403/seat/rate-limit response from a Figma tool."
---

# Figma connection preflight

figma-forge bundles the Figma MCP server in its own `.mcp.json`, so installing the plugin
installs the server. The server still needs a **one-time OAuth sign-in per machine**, which
only the user can complete. This skill makes that the first thing that happens, not a
mid-build surprise.

## 1. Check before you build

Run `whoami` as the first Figma call of a session:

```
mcp__plugin_figma_figma__whoami
```

**Connected** — it returns a handle, email, and a `plans` array. Note two things and move on:

- the **plan key** you will create files in (`team::…` or `organization::…`)
- the **seat** on that plan

**Not connected** — the call fails with an auth/401/403 error, or the Figma tools are
missing entirely. Stop and hand the user the fix below. Do not try to work around it, and
do not retry the same call in a loop.

## 2. What to tell the user when it is not connected

Keep it to the three lines that matter:

> The Figma MCP server is installed but not signed in yet. Run `/mcp`, pick **figma**, and
> choose Authenticate — it opens Figma in your browser for a one-time approval. Tell me when
> it's done and I'll pick up where I left off.

If `/mcp` does not list a `figma` server at all, the plugin is not loaded in this session:
have the user confirm figma-forge is installed and enabled, then restart Claude Code.

## 3. Seats decide what is possible

Read the seat on the plan you intend to write to:

| Seat on that plan | What works |
|---|---|
| **Full** | Everything — `use_figma`, `create_new_file`, `upload_assets` |
| **View** / guest | Read-only: `get_design_context`, `get_screenshot`, `get_metadata` |

A `View` seat is the usual cause of a confusing permission error *after* a successful
`whoami`. If the user has several plans, pick a **Full** one for any build, and say which
one you chose. If every plan is View-only, say so before extracting anything — the design
can still be extracted to JSON, it just cannot be written into Figma.

## 4. Picking the target file

Never guess a destination.

- The user gave a Figma URL → pull the `fileKey` from
  `figma.com/design/:fileKey/:name`, and pass it to every call.
- No file yet → load the `figma-create-new-file` skill, then `create_new_file` with a
  `planKey` from `whoami` and `editorType: "design"`. If more than one plan has a Full
  seat, ask which team before creating.

Hold on to the `fileKey`: every `use_figma`, `upload_assets`, and `get_screenshot` call
needs it.

## 5. Errors that mean "come back here"

| Symptom | Reading |
|---|---|
| 401 / 403 / "unauthorized" | Not signed in, or signed in as a different account — §2 |
| "permission denied" after a clean `whoami` | View seat, or no access to that file — §3 |
| Rate limited | Figma throttles per account; wait, then resume at the next unbuilt section |
| Figma tools absent from the tool list | Plugin not loaded — §2, last paragraph |

Re-run `whoami` after the user says they have connected, and confirm the handle before
continuing. Then resume the interrupted workflow at the step it stopped on — extraction
output on disk is still valid, so nothing needs re-scraping.
