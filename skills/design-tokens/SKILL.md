---
name: design-tokens
description: "Turn an extracted or authored token set into Figma variables and text styles — colour ramps, type scale, spacing, radii, shadows, light/dark modes. Triggers: 'create Figma variables', 'set up design tokens in Figma', 'build a colour ramp', 'make text styles from our scale', 'extract the design system from this site', 'sync our tokens to Figma', 'add dark mode variables'. Load alongside url-to-figma or code-to-figma before building any page, so layers reference variables instead of hardcoded values."
---

# Tokens → Figma variables

A page built from raw hex values is a picture. A page built from variables is a design system
someone can retheme. Always create the variables **before** building sections.

## Input

`tokens.json` from `derive-tokens.mjs`, the project's own token source, or both. Read
`summary` and `recommended` first — `recommended` is the curated subset:

- `recommended.colors` — the ~16 colours that carry the page
- `recommended.typography` — the type scale with its shape preserved (display → caption)
- `recommended.spacing` — on-grid steps only, with `summary.baseUnit` as the grid

The full lists stay in the file for when something specific is missing. Do not create a
variable for every one of 58 observed colours; that is a pile, not a system.

## Order of work

**1. Collections before variables.** One collection per axis of change. A typical set:

| Collection | Modes | Holds |
|---|---|---|
| `Primitives` | one | Raw ramps — `blue/600`, `neutral/100` |
| `Semantic` | `Light`, `Dark` | Roles that alias primitives — `bg/surface`, `text/primary` |
| `Scale` | one | `space/*`, `radius/*` |

Primitives are what the extractor found. Semantic names are the judgment you add: a page
is themeable only because `bg/surface` can point at `neutral/50` in Light and `neutral/900`
in Dark. Derive semantic roles from how each colour was actually used — `tokens.json` records
`roles` (`fill`, `text`, `border`, `background`, `gradient`) per colour.

**2. Set `scopes` explicitly on every variable.** The default `ALL_SCOPES` pollutes every
picker in the file. Use `["FRAME_FILL","SHAPE_FILL"]` for backgrounds, `["TEXT_FILL"]` for
text colours, `["GAP"]` for spacing, `["CORNER_RADIUS"]` for radii.

**3. Text styles after the type scale exists.** Each entry in `tokens.typography` becomes one
text style: family, size, weight, line height, letter spacing, case. Resolve the font family
against `figma.listAvailableFontsAsync()` first — web fonts like `sohne-var` or `Inter var`
usually are not installed, and loading an unavailable font throws. Map to the nearest
available family and weight, and tell the user what was substituted.

**4. Effects styles for shadows.** `tokens.shadows` is already ordered smallest to largest and
named `shadow/xs … shadow/2xl`.

## Rules that bite

- `figma.loadFontAsync` must complete for **every** font before any text is created or
  mutated — including fonts only used by a range inside a string.
- Figma's Inter styles contain spaces: `"Semi Bold"`, `"Extra Bold"`. Never guess a style
  string; read it from `listAvailableFontsAsync()`.
- Colours are 0–1, and paint `color` objects take `{r,g,b}` only — opacity lives on the paint.
- `setBoundVariableForPaint` returns a **new** paint; capture and reassign it.
- Create variables with the collection **object**, not just its id, where the API allows.

Load **figma-use** before any `use_figma` call — these rules and their failure modes are
documented there in full, and `figma-generate-library` covers the component layer that sits
on top of these variables.

## Binding the page to the tokens

After the variables exist and the sections are built, bind the layers: for each node, look up
its literal fill against the palette and `setBoundVariable('fills', …)`. Work in batches by
colour — one pass per variable across all matching nodes — rather than node by node. Return
the mutated node ids so the work is checkable.

If a literal does not match any token within a small tolerance, leave it literal and report
it. A near-miss usually means a one-off value the site itself never systematised, and forcing
it into the ramp loses information.
