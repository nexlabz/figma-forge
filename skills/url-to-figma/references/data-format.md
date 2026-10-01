# Extraction output format

Read this only when you need to work with the raw capture — inspect a specific node, debug a
mismatch, or write a custom transform. The normal pipeline never needs it: `--list-sections`
and the generated scripts do the reading for you.

## Files

```
figma-forge-out/<host>/
├── index.json              # capture summary — safe to read in full
├── design-desktop.json     # the design tree — megabytes, do NOT read whole
├── design-mobile.json
├── screenshot-desktop.png  # reference render
└── assets/
    ├── asset-1.svg
    └── asset-8.webp
```

## `design-<viewport>.json`

```jsonc
{
  "meta": {
    "url": "https://…", "title": "…",
    "viewport": { "width": 1440, "height": 900, "dpr": 1 },
    "page":     { "width": 1440, "height": 15140 },   // full scroll size
    "background": { "color": {"r":1,"g":1,"b":1,"a":1}, "hex": "#ffffff" },
    "viewportPreset": "desktop",
    "screenshot": "screenshot-desktop.png"
  },
  "fonts":  [ { "family": "sohne-var", "weight": 300, "italic": false, "count": 320 } ],
  "tree":   { /* root node */ },
  "assets": [ { "id": "asset-8", "kind": "image", "url": "…", "file": "assets/asset-8.webp",
                "bytes": 33544, "downloaded": true, "error": null } ],
  "stats":  { "nodeCount": 2055, "walked": 2836, "truncated": false, "byType": { … } },
  "warnings": []
}
```

`stats.nodeCount` is what survived pruning; `walked` is how many DOM elements were visited.
`truncated: true` means the node budget was hit — re-run with a higher `--max-nodes`.

## Nodes

Every node carries **absolute page coordinates** in `rect` (`x`, `y` include scroll offset).
That is what lets a subtree be built at any nesting level and still land correctly.

| Field | Meaning |
|---|---|
| `type` | `FRAME` `TEXT` `IMAGE` `VECTOR` `RECT` `INPUT` `PLACEHOLDER` |
| `rect` | `{x, y, width, height}` in absolute page space |
| `name` / `path` | Human label and a short CSS-ish path for traceability |
| `fill` | Solid background — `{type, color{r,g,b}, hex, opacity}`, channels 0–1 |
| `backgroundLayers` | Gradients (`GRADIENT_LINEAR`/`RADIAL`/`ANGULAR` with `angle` and `stops`) and background images |
| `border` | `{uniform, top, right, bottom, left}`, each `{width, style, color, hex}` |
| `radius` | `{topLeft, topRight, bottomRight, bottomLeft, uniform}`, percentages resolved to px |
| `effects` | Box shadows — `{type, color, offsetX, offsetY, blur, spread}` |
| `autoLayout` | Present when the element was flex/grid — `{mode, itemSpacing, padding, justifyContent, alignItems}` |
| `clipsContent` | `overflow: hidden` |
| `opacity`, `hidden` | `hidden` covers visibility, zero size, clip-rect and opacity-0 chains |
| `children` | Child nodes in document (paint) order |

### TEXT nodes

One layer per paragraph — sites that split text into per-character `<span>`s are coalesced
back together.

```jsonc
{
  "type": "TEXT",
  "characters": "Financial infrastructure to grow your revenue",
  "rect":    { … },   // content box — use this width so lines wrap as they did
  "inkRect": { … },   // tight bounds of the glyphs
  "boxRect": { … },   // the element's full border box
  "font": { "family": "sohne-var", "size": 48, "weight": 300, "italic": false,
            "lineHeight": {"unit":"PIXELS","value":55.2},
            "letterSpacing": {"unit":"PIXELS","value":-0.5},
            "align": "left", "transform": "none", "decoration": "none",
            "color": {…}, "colorHex": "#061b31" },
  "styleRuns": [ { "start": 0, "end": 46, "colorHex": "#061b31", "weight": 500,
                   "href": "https://…" } ]
}
```

`styleRuns` are character-range overrides against the base `font` — bold spans, links,
inline colour changes. Offsets index into `characters`. Apply them with Figma's
`setRangeFontName` / `setRangeFills` / `setRangeFontSize`.

### IMAGE and VECTOR

- `IMAGE` → `image.assetId` points into `assets[]`; `objectFit` maps to Figma's `scaleMode`
  (`cover`→`FILL`, `contain`→`FIT`).
- `VECTOR` → `svg.assetId`; the markup lives at `assets/<id>.svg`. Small SVGs get inlined
  into the generated script via `figma.createNodeFromSvg`; larger ones become placeholders.

## Known limits

| Limit | Why, and what to do |
|---|---|
| One state per capture | Hover/open/error states need their own run, driven through the URL |
| `canvas` / `video` / `iframe` → `PLACEHOLDER` | Their contents are not in the DOM; the poster frame is recorded for video |
| CSS filters, blend modes, masks, 3-D transforms | Not extracted — check the screenshot and add them by hand if they matter |
| `position: fixed` elements | Captured at scroll-top; a sticky header lands where it sits on load |
| Fractional line heights | Preserved per node, but `derive-tokens.mjs` reports the modal value per size/weight |
