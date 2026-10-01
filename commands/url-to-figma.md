---
description: Turn a website URL into an editable Figma design
argument-hint: <url> [--viewports desktop,mobile] [--figma <file-url>]
---

Turn this into a Figma design: **$ARGUMENTS**

Load the `url-to-figma` skill and follow it end to end. Before anything else, run the
`figma-connect` preflight — confirm a Full seat and settle the target file (an existing
Figma URL if the user gave one, otherwise create a file and say which team it went in).

Then: extract → derive tokens → **ask whether to build a design system first or go straight to
the page** → build sections in order → upload images → screenshot and compare against the
captured reference.

Put the design-system question to the user with `AskUserQuestion` after the tokens exist, so
you can tell them what it would contain. Never skip it unless they already said which they want.

Each website page gets its **own Figma page**, named from the URL path; every viewport of that
page sits on it side by side as separate frames.

If the user named viewports, pass them through to `--viewports`. If not, capture `desktop`
and mention that `--viewports desktop,tablet,mobile` would give responsive frames.

Tell the user the section count before you start building, and give them the Figma link as
soon as the file exists — not only at the end.
