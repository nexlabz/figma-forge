---
name: url-to-figma
description: "Turn a live website into an editable Figma design. Renders the URL in headless Chrome, extracts real geometry, paints, type and assets, derives design tokens, then builds the page into Figma section by section. Triggers: 'turn this website into a Figma design', 'recreate <url> in Figma', 'import this site into Figma', 'website to Figma', 'convert this landing page to Figma', 'scrape this page into Figma', 'make a Figma file from this URL', 'redesign this site' (capture it first), 'extract the design system from this website'. Use whenever the input is a URL and the output should be design, not code."
---

# URL → Figma

Turns a rendered page into an editable Figma file. The pipeline is deterministic: scripts do
the measuring and the code generation, you make the design judgments and drive the Figma MCP.

```
extract-site.mjs  →  derive-tokens.mjs  →  to-figma-script.mjs  →  use_figma  →  upload-assets.mjs
   render + measure     name the tokens      emit Plugin API JS      build         swap in images
```

`${CLAUDE_PLUGIN_ROOT}` is this plugin's directory. All scripts are plain Node (>= 20) with
**no npm install** — they drive the system Chrome over the DevTools Protocol.

## 0. Preflight — do this first

Load **figma-connect** and run `whoami`. Confirm a **Full** seat on the plan you will write
to, and get a `fileKey` (existing file) or create one. Never start extracting before you know
the build target exists — the user may need to authenticate, and that is better found out now.

## 1. Extract the page

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/extract-site.mjs <url> \
  --viewports desktop \
  --out ./figma-forge-out/<host>
```

- Multiple breakpoints in one run: `--viewports desktop,tablet,mobile`. Each becomes its own
  Figma frame — that is how you deliver a responsive design, not by guessing.
- Presets: `desktop` 1440, `desktop-lg` 1920, `laptop` 1280, `tablet` 834, `mobile` 390. Or
  pass `1600x1000`.
- Behind a login: `--cookie "session=…"` (repeatable) or `--header "Authorization: Bearer …"`.
- Heavy page that still looks half-loaded: raise `--wait 3000`, or `--max-nodes 6000`.

Read **`index.json`** and **`screenshot-<viewport>.png`** — never the `design-*.json`, which
runs to megabytes. The screenshot is your reference for the whole build; look at it before
deciding anything about structure.

What the extractor already handled, so you do not need to re-reason about it: lazy images
(it autoscrolls), animations (frozen), per-character `<span>` splitting (coalesced into one
text layer per paragraph), and content hidden via `opacity:0` on descendants (dropped).

## 2. Derive tokens

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/derive-tokens.mjs ./figma-forge-out/<host>/design-*.json
```

Writes `tokens.json`: a colour palette with Tailwind-style names, a type scale, a spacing
scale with the inferred base unit, radii and shadows. Read `summary` and `recommended`, not
the full lists — `recommended` is the subset worth turning into Figma variables.

Build the variables **before** the sections, so the page is built against tokens rather than
hardcoded hexes. Load **design-tokens** for that step.

## 3. Ask: design system, or straight to the page?

**Put this to the user before the first write to Figma, every time** — unless they have already
said which they want. Ask it here, not earlier: you have just derived the tokens, so you can
tell them what a design system would actually contain.

Use `AskUserQuestion` with these two options:

- **Design system first** — build the variables, text styles and effect styles from
  `tokens.json`, then build the page bound to them. A handful of extra calls, and the result
  is a file that can be rethemed, extended and handed to a designer. Say the real numbers:
  "a 14-colour palette, 12 text styles, a 4px spacing grid".
- **Just the page** — build it directly with literal fills and fonts. Fastest route to
  something that looks right, and the usual choice for a one-off reference or a quick look.

Recommend **design system first** when the token set came out coherent (a clear type scale, a
small palette, a consistent grid) or when the user mentioned redesigning, extending, theming or
handing off. Recommend **just the page** when they asked to "see what it looks like", the page
is a one-off, or the derived tokens are scattered.

If they pick the design system, load **design-tokens** and build the variables now, before any
section. Binding is far cheaper than rebinding later.

## 4. Plan the build

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/to-figma-script.mjs ./figma-forge-out/<host>/design-desktop.json --list-sections
```

Each section is pre-sized to fit `use_figma`'s 50,000-character limit. Expect 10–25 sections
for a marketing page. Tell the user the count up front — this is a multi-call build.

### How the file is organised

**One Figma page per website page. All viewports of that page share it.**

- The script derives the Figma page name from the URL path — `/` → `Home`,
  `/pricing` → `Pricing`, `/solutions/ci-cd` → `Solutions / Ci cd` — and creates it if it does
  not exist. Override with `--page "<name>"`.
- Every viewport of the same URL lands on that one page as its own frame
  (`stripe.com — desktop`, `stripe.com — tablet`, `stripe.com — mobile`), auto-placed left to
  right with a 160px gutter. You do not need to pass `--x`; pass it only to override.
- Capturing several URLs means running the pipeline once per URL. Each gets its own Figma page,
  so a 5-page site becomes 5 Figma pages in one file.
- Flatten everything onto a single page **only if the user asks** — then pass the same
  `--page` to every run.

## 5. Build, section by section

For each section index, in order:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/to-figma-script.mjs <design.json> --section <i> --out /tmp/ff-<i>.js
```

Read the file and pass its contents as `use_figma`'s `code`, with the `fileKey` from step 0.
Load the **figma-use** skill first — it is a mandatory prerequisite for `use_figma` — and pass
`skillNames: "figma-use,url-to-figma"`.

Order matters: section 0 creates the page frame; later sections find it by name and append to
it. Build sections in ascending order and do not run them in parallel.

Each call returns `createdCount` and `fontWarnings`. Fonts the site used that Figma does not
have are auto-mapped to the nearest available weight — surface that list to the user once, at
the end, rather than after every call.

**If a call fails**, check `safeToRetryWithoutCanvasRead`. When true, fix and re-run the same
section. When false, read the canvas first: a half-built section must be cleaned up before
retrying, or you will get duplicates.

## 6. Swap placeholders for real images

The build leaves grey rectangles named `IMG:<assetId> <name>`. Small SVGs are already inlined
as real vectors; everything else needs uploading.

1. Get the manifest, which defines the required order:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/upload-assets.mjs --dir ./figma-forge-out/<host> --list
   ```

2. Map asset ids to the node ids Figma assigned, via `use_figma`:

   ```js
   const out = {};
   for (const n of figma.currentPage.query('RECTANGLE[name^=IMG:]')) {
     out[n.name.split(' ')[0].slice(4)] = n.id;
   }
   return out;
   ```

3. Call `upload_assets` with `count` = manifest length and `nodeIds` in **manifest order**
   (look each id up in the step-2 map). Max 60 per call — page with `--skip`.

4. POST the bytes. Write the returned URLs to a plan file as
   `[{"assetId":"asset-8","url":"https://…"}, …]`, then:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/upload-assets.mjs --dir ./figma-forge-out/<host> --plan plan.json
   ```

Any asset that fails stays a named placeholder — that is a fine outcome, just say which ones.

## 7. Verify against the original

Take `get_screenshot` of the built frame and compare it with `screenshot-<viewport>.png`.
Check, in this order: overall section rhythm → type scale → colour → image placement. Fix the
largest discrepancy first with a targeted `use_figma` call; do not rebuild a whole section for
a small offset.

Stop when the frame reads as the same page. Pixel-identical is not the goal — an editable,
faithful design is.

## Choices worth making deliberately

**Absolute position vs auto-layout.** The default is absolute, which reproduces the page
exactly. Pass `--auto-layout` to convert flex/grid containers into Figma auto-layout: better
to hand to a designer, but text reflow can shift things. Default to absolute for a faithful
capture; use `--auto-layout` when the user says they will edit or extend the design.

**Which breakpoints.** One desktop frame answers "what does this look like in Figma". Three
frames answer "redesign this responsively". Ask only if the user's intent is genuinely unclear.

**Big pages.** A 15,000px page is normal and fine. If sections exceed 25, offer to build the
top N first so the user sees something quickly.

## When this is the wrong tool

- The user wants **code** from a Figma design → `figma-design-to-code`.
- The user wants to push **their own codebase's** components into Figma → `code-to-figma`.
- The page needs a login flow the user cannot express as a cookie or header → say so; the
  extractor cannot drive an interactive sign-in.
