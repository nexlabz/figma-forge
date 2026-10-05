# figma-forge

Turn **code** and **live websites** into editable Figma designs.

The Figma MCP server is bundled with this plugin — installing figma-forge installs it. You
sign in once (`/mcp` → figma → Authenticate) and everything after that is one command.

## Install

```
/plugin marketplace add nexlabz/figma-forge
/plugin install figma-forge@figma-forge
```

Then sign in to Figma once — `/mcp` → **figma** → Authenticate — and run:

```
/figma-forge:url-to-figma https://stripe.com
```

## What it does

```
URL or dev server
      │
      ▼
 extract-site.mjs ──► renders in headless Chrome, measures the real DOM
      │                geometry · paints · gradients · shadows · type · assets
      ▼
 derive-tokens.mjs ─► names what it found: colour ramps, type scale, spacing grid
      │
      ▼
to-figma-script.mjs ► emits Figma Plugin API code, chunked to fit use_figma
      │
      ▼
   use_figma ───────► builds the design, section by section
      │
      ▼
upload-assets.mjs ──► swaps image placeholders for the real bitmaps
```

## Commands

| Command | Does |
|---|---|
| `/figma-forge:url-to-figma <url>` | Website → Figma design |
| `/figma-forge:code-to-figma <path\|url>` | Codebase page or component library → Figma |
| `/figma-forge:artifact-to-figma <url>` | Claude artifact → Figma artboards |
| `/figma-forge:tokens <dir\|url>` | Design tokens → Figma variables and text styles |
| `/figma-forge:connect` | Check the Figma connection and sign in |

## Skills

Model-invoked, so plain language works too — "recreate this landing page in Figma" reaches
the same place as the command.

| Skill | Covers |
|---|---|
| `url-to-figma` | The full URL → Figma pipeline |
| `code-to-figma` | Render route for pages; design-system route for component libraries |
| `artifact-to-figma` | Claude artifacts → Figma, one artboard per board on a design canvas |
| `design-tokens` | Token sets → Figma variables, text styles, effect styles, light/dark modes |
| `figma-connect` | Connection preflight, seats, picking the target file |

## How the Figma file is organised

**One Figma page per website page — every viewport of that page shares it.**

```
Figma file
├─ Home          ← figma-forge:url-to-figma https://acme.com
│    acme.com — desktop   acme.com — tablet   acme.com — mobile
├─ Pricing       ← figma-forge:url-to-figma https://acme.com/pricing
│    acme.com — desktop   acme.com — mobile
└─ Docs / Api
```

Page names come from the URL path (`/` → `Home`, `/solutions/ci-cd` → `Solutions / Ci cd`) and
frames are auto-placed left to right. Override with `--page`, or put everything on one page by
passing the same `--page` to every run.

## It asks before it builds

Once the tokens are derived, you get a choice:

- **Design system first** — variables, text styles and effect styles built from the real
  tokens, with the page bound to them. A retheme-able file.
- **Just the page** — literal values, fastest route to something that looks right.

## What makes the capture faithful

Real pages fight naive scrapers. This one handles:

- **Lazy loading** — autoscrolls the full page and waits for images and fonts
- **Animations** — frozen before measuring, so the capture is deterministic
- **Split text** — sites that wrap every character in a `<span>` for animation collapse back
  to one text layer per paragraph, with bold/link runs preserved as character ranges
- **Hidden-but-present content** — carousels and alternate-language blocks hidden by
  `opacity:0` on a descendant are dropped instead of stacked on top of each other
- **Gradients, shadows, per-corner radii, per-side borders** — parsed to Figma's model
- **Fonts Figma does not have** — mapped to the nearest available family and weight, and the
  substitutions are reported
- **Text that must not re-wrap** — Figma measures a hair wider than the browser, so text
  that was one line stays one line instead of breaking
- **Rotation and mirroring** — CSS transforms carry through as real Figma transforms, so
  tilted lockups and flipped icons land the right way round

## Requirements

- **Node ≥ 20** and **Chrome or Chromium** on PATH (or set `CHROME_PATH`)
- A Figma account with a **Full** seat on the team you build into
- No `npm install` — the scripts use Node's built-in `fetch` and `WebSocket` to drive Chrome
  over the DevTools Protocol

## Scripts

Usable directly; every one takes `--help`.

```bash
# A Claude artifact or any local HTML — served automatically, no web server needed
node scripts/extract-site.mjs ./artifact.html --viewport 3700x1200 --wait 4000 --out ./out
node scripts/to-figma-script.mjs ./out/design-*.json --split-frames auto --auto-label --list-sections

# Capture a page at several breakpoints
node scripts/extract-site.mjs https://example.com --viewports desktop,tablet,mobile --out ./out

# Behind a login
node scripts/extract-site.mjs https://app.example.com --cookie "session=abc" --out ./out

# Name the tokens
node scripts/derive-tokens.mjs ./out/design-*.json

# Plan and emit the Figma build
node scripts/to-figma-script.mjs ./out/design-desktop.json --list-sections
node scripts/to-figma-script.mjs ./out/design-desktop.json --section 0 --out /tmp/s0.js

# Push the images
node scripts/upload-assets.mjs --dir ./out --list
node scripts/upload-assets.mjs --dir ./out --plan plan.json
```

## Limits worth knowing

One state per capture — hover, open and error states need their own run driven through the
URL. `canvas`, `video` and `iframe` content becomes a named placeholder. CSS filters, blend
modes and masks are not extracted. See
[`skills/url-to-figma/references/data-format.md`](skills/url-to-figma/references/data-format.md)
for the full list and the capture schema.
