---
description: Push a page, screen, or component from this codebase into Figma
argument-hint: <path, route, or local url> [--figma <file-url>]
---

Push this into Figma: **$ARGUMENTS**

Load the `code-to-figma` skill. Run the `figma-connect` preflight first.

Decide the route and say which you picked:

- A **page or screen** → render route: start the dev server, get the real URL, then follow
  `url-to-figma` from its extraction step.
- A **component library** → design-system route: `figma-generate-library` plus
  `figma-code-connect`, using this project's own tokens for the variable names.

Prefer the repository's real token names (`tailwind.config.*`, `:root` custom properties, a
theme file) over names derived from pixels.

If the dev server will not start, say so and stop — do not hand-translate source into Figma
nodes.
