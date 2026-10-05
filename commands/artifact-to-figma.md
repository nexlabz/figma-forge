---
description: Export the designs in a Claude artifact into Figma
argument-hint: <claude.ai artifact url> [--page "Name"] [--figma <file-url>]
---

Export this artifact into Figma: **$ARGUMENTS**

Load the `artifact-to-figma` skill and follow it. Run the `figma-connect` preflight first.

Read the artifact with the **Artifact tool's `read` action** — never WebFetch — and
extract from the local HTML path it saves, not from the summary, which is usually just a
loading shell.

Decide from the reference screenshot whether this is a canvas of boards (use
`--split-frames auto --auto-label`) or a single page (use the normal section flow), and
say which you chose and how many artboards it will make before you start building.

Put it on its own Figma page, named after the artifact unless the user named one.
