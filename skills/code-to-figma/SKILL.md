---
name: code-to-figma
description: "Turn code into a Figma design — push a React/Vue/Svelte/HTML page, screen, or component library from a local codebase into Figma. Runs the app, captures the real rendered output, and builds it in Figma against the project's own design tokens. Triggers: 'turn this component into a Figma design', 'push this page to Figma', 'code to design', 'create a Figma file from my codebase', 'build our design system in Figma from code', 'mirror this screen in Figma', 'sync my components to Figma', 'reverse engineer our UI into Figma'. Use when the source is a repository rather than a URL."
---

# Code → Figma

Two routes into Figma from a codebase. Pick by what the user wants out of it.

| Want | Route | Why |
|---|---|---|
| A faithful design of a page/screen as it really renders | **Render route** (§A) | Measures the real browser output — correct type, spacing, shadows, images |
| Reusable components, variants and variables in a library | **Design-system route** (§B) | Needs semantic intent that rendered pixels cannot supply |

Both start the same way: load **figma-connect**, run `whoami`, confirm a Full seat and a
`fileKey`.

## A. Render route — a page or screen

The honest way to get a component into Figma is to render it, not to read its JSX and guess
at computed styles. Cascade, inherited type and media queries all resolve at runtime.

1. **Get it on a local URL.** Start the dev server the way the project does (`npm run dev`,
   `pnpm dev`, Storybook's `dev` script…). Check for a project `run` skill first. Note the
   port and the exact path for the screen in question — Storybook gives one URL per story via
   `/iframe.html?id=<story-id>`, which captures a component with no app chrome around it.

2. **Hand that URL to the url-to-figma pipeline.** Everything downstream is identical:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/extract-site.mjs http://localhost:3000/pricing \
     --out ./figma-forge-out/pricing
   ```

   Load **url-to-figma** and follow it from its step 2. Local URLs need no special handling;
   `http://` is accepted as-is.

   Its rules apply unchanged: **ask the user whether to build a design system first or go
   straight to the page** before the first write, and give each route or screen its own Figma
   page with its viewports side by side on it.

3. **Prefer the project's real tokens over derived ones.** `derive-tokens.mjs` infers tokens
   from pixels. If the repo already defines them — `tailwind.config.*`, a `tokens.json`, CSS
   custom properties in `:root`, a theme file — those names are the truth. Read them and use
   **design-tokens** to build Figma variables from the source names, then let the derived
   token file fill only the gaps. A Figma variable called `brand/primary` is worth far more
   than one called `blue/600`.

4. **Capture each state that matters.** Default, hover, disabled, error, empty, loading, dark
   mode. The extractor captures one state per run, so drive the state through the URL
   (Storybook args, a query param, a route) and run it once per state, into sibling output
   directories. Name the Figma frames for the state via `--root-name`.

## B. Design-system route — components and variables

When the deliverable is a **library** — components with variants, bound variables, published
styles — rendering alone is not enough. A rendered button is a rectangle; a Figma component
needs to know that `size` and `variant` are its properties.

Use the Figma plugin's own skills, which are built for exactly this:

- **figma-generate-library** — what to build and in what order (variables first, then
  components, then variants).
- **figma-use** — mandatory before any `use_figma` call.

figma-forge's contribution here is the inputs:

- Run the render route against a Storybook/stories index and use the resulting
  `tokens.json` plus screenshots as ground truth for each component's real metrics.
- Enumerate the component's actual prop combinations from its source (TypeScript props,
  `cva`/`tv` variant maps, Storybook `argTypes`) — that list becomes the Figma variant matrix.
  Do not invent variants the code does not have, and do not silently skip ones it does.

Then map the two together with **figma-code-connect** so the Figma component points back at
the real source file. That is what keeps the library from drifting on the next refactor.

## Reading a codebase for design intent

Worth reading before you build — these carry naming that pixels do not:

| Source | What it gives |
|---|---|
| `tailwind.config.*` / `@theme` | The canonical scale and token names |
| CSS custom properties on `:root` | Semantic names and the dark-mode mapping |
| `cva` / `tailwind-variants` / `styled` variant maps | The exact variant matrix |
| Storybook stories | The states the team considers real |
| An existing `*.figma.ts` Code Connect file | Components already mapped — reuse, do not duplicate |

## Keep it honest

- If the dev server will not start, say so and stop. Do not hand-translate JSX into Figma
  nodes from reading the source — the result looks plausible and is quietly wrong.
- If a component renders differently in CI than locally (fonts, feature flags), capture the
  environment the user actually cares about and name it in the frame.
- Report what you skipped. "Built 6 of 8 components; `DataGrid` and `Chart` render to canvas
  and came through as placeholders" is a good outcome, stated plainly.
