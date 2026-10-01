---
description: Derive design tokens from an extraction and build them as Figma variables
argument-hint: <extraction-dir or url> [--figma <file-url>]
---

Derive and build design tokens for: **$ARGUMENTS**

If the argument is a URL, extract it first with
`${CLAUDE_PLUGIN_ROOT}/scripts/extract-site.mjs`. If it is a directory, use the
`design-*.json` already in it.

Then run `${CLAUDE_PLUGIN_ROOT}/scripts/derive-tokens.mjs` over every `design-*.json` in that
directory — passing all viewports at once gives a better scale than one alone.

Load the `design-tokens` skill and build the result into Figma as variables, text styles and
effect styles. Report the palette size, the type scale, and the inferred base spacing unit.

Show the user the `recommended` subset and ask before creating anything beyond it.
