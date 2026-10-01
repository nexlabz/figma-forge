#!/usr/bin/env node
/**
 * figma-forge — design-token derivation.
 *
 * Reads one or more design-*.json captures and rolls the raw computed styles up
 * into a named token set: colour ramps, a type scale, spacing, radii, shadows.
 * These map 1:1 onto Figma variables and text styles.
 *
 * Usage:
 *   node scripts/derive-tokens.mjs <design.json...> [--out tokens.json] [--min-count 2]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';

// ------------------------------------------------------------------ colour
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

const HUES = [
  [345, 15, 'red'], [15, 45, 'orange'], [45, 65, 'yellow'], [65, 100, 'lime'],
  [100, 160, 'green'], [160, 185, 'teal'], [185, 205, 'cyan'], [205, 250, 'blue'],
  [250, 280, 'indigo'], [280, 310, 'purple'], [310, 345, 'pink'],
];

function hueName(h) {
  for (const [lo, hi, name] of HUES) {
    if (lo > hi) { if (h >= lo || h < hi) return name; }
    else if (h >= lo && h < hi) return name;
  }
  return 'neutral';
}

/** Tailwind-ish step from lightness: 50 (lightest) … 950 (darkest). */
const STEPS = [[0.97, 50], [0.93, 100], [0.86, 200], [0.76, 300], [0.65, 400], [0.54, 500], [0.44, 600], [0.34, 700], [0.25, 800], [0.14, 900], [0, 950]];
function lightnessStep(l) {
  for (const [min, step] of STEPS) if (l >= min) return step;
  return 950;
}

function colorName(hex, rgb) {
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (l >= 0.995) return 'neutral/white';
  if (l <= 0.005) return 'neutral/black';
  const family = s < 0.1 ? 'neutral' : hueName(h);
  return `${family}/${lightnessStep(l)}`;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

/** Perceptual-ish distance, weighted toward human luminance sensitivity. */
function colorDistance(a, b) {
  const dr = (a.r - b.r) * 0.3, dg = (a.g - b.g) * 0.59, db = (a.b - b.b) * 0.11;
  return Math.sqrt(dr * dr + dg * dg + db * db) * 3;
}

// ------------------------------------------------------------------ walking
function walk(node, fn, parent = null) {
  if (!node) return;
  fn(node, parent);
  for (const c of node.children || []) walk(c, fn, node);
}

function bump(map, key, payload) {
  if (!map.has(key)) map.set(key, { count: 0, ...payload, samples: [] });
  const e = map.get(key);
  e.count++;
  if (payload.sample && e.samples.length < 5 && !e.samples.includes(payload.sample)) e.samples.push(payload.sample);
  return e;
}

/** Most frequent key in a count map — the value a designer would actually pick. */
function modeOf(map) {
  if (!map || !map.size) return null;
  let best = null, bestN = -1;
  for (const [k, n] of map) if (n > bestN) { best = k; bestN = n; }
  return best;
}

function area(n) { return Math.max(0, n.rect?.width || 0) * Math.max(0, n.rect?.height || 0); }

async function main() {
  const argv = process.argv.slice(2);
  const files = [];
  let out = null, minCount = 2, mergeTolerance = 0.045;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--min-count') minCount = parseInt(argv[++i], 10);
    else if (argv[i] === '--tolerance') mergeTolerance = parseFloat(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') { console.log('Usage: derive-tokens.mjs <design.json...> [--out tokens.json] [--min-count 2] [--tolerance 0.045]'); process.exit(0); }
    else files.push(argv[i]);
  }
  if (!files.length) { console.error('Need at least one design-*.json. See --help.'); process.exit(2); }

  const colors = new Map();     // hex -> {count, roles, samples}
  const typography = new Map();
  const spacing = new Map();
  const radii = new Map();
  const shadows = new Map();
  const fontFamilies = new Map();
  const sources = [];

  for (const f of files) {
    const path = resolve(f);
    const data = JSON.parse(await readFile(path, 'utf8'));
    sources.push({ file: path, url: data.meta?.url, viewport: data.meta?.viewportPreset, nodes: data.stats?.nodeCount });

    if (data.meta?.background?.hex) {
      const e = bump(colors, data.meta.background.hex.slice(0, 7), { sample: 'page background' });
      (e.roles ||= new Set()).add('background');
      e.weightedArea = (e.weightedArea || 0) + 1e6;
    }

    walk(data.tree, (n) => {
      // ---- colours
      if (n.fill?.hex) {
        const e = bump(colors, n.fill.hex.slice(0, 7), { sample: n.name });
        (e.roles ||= new Set()).add('fill');
        e.weightedArea = (e.weightedArea || 0) + area(n);
      }
      if (n.font?.colorHex) {
        const e = bump(colors, n.font.colorHex.slice(0, 7), { sample: n.name });
        (e.roles ||= new Set()).add('text');
      }
      if (n.border) {
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const b = n.border[side];
          if (b?.hex) { const e = bump(colors, b.hex.slice(0, 7), { sample: n.name }); (e.roles ||= new Set()).add('border'); }
        }
      }
      for (const layer of n.backgroundLayers || []) {
        for (const stop of layer.gradient?.stops || []) {
          if (stop.hex) { const e = bump(colors, stop.hex.slice(0, 7), { sample: n.name }); (e.roles ||= new Set()).add('gradient'); }
        }
      }
      for (const run of n.styleRuns || []) {
        if (run.colorHex) { const e = bump(colors, run.colorHex.slice(0, 7), { sample: n.name }); (e.roles ||= new Set()).add('text'); }
      }

      // ---- typography
      if (n.type === 'TEXT' && n.font) {
        const f = n.font;
        // Round the size and ignore sub-pixel line-height drift: designers think in
        // size + weight, not in 57.68px vs 55.2px leading on the same 48px type.
        const size = Math.round(f.size * 2) / 2;
        const key = [f.family, size, f.weight, f.italic ? 'i' : 'n'].join('|');
        const entry = bump(typography, key, {
          family: f.family, size, weight: f.weight, italic: !!f.italic,
          transform: f.transform, sample: (n.characters || '').slice(0, 48),
        });
        entry.lineHeights ||= new Map();
        entry.letterSpacings ||= new Map();
        const lh = f.lineHeight ? Math.round(f.lineHeight.value * 10) / 10 : null;
        const ls = f.letterSpacing ? Math.round(f.letterSpacing.value * 100) / 100 : 0;
        entry.lineHeights.set(lh, (entry.lineHeights.get(lh) || 0) + 1);
        entry.letterSpacings.set(ls, (entry.letterSpacings.get(ls) || 0) + 1);
        bump(fontFamilies, `${f.family}|${f.weight}|${f.italic ? 'i' : 'n'}`, { family: f.family, weight: f.weight, italic: !!f.italic });
      }

      // ---- spacing (gaps and padding)
      const al = n.autoLayout;
      if (al) {
        for (const v of [al.itemSpacing, al.counterAxisSpacing]) {
          if (v > 0) bump(spacing, String(Math.round(v)), { value: Math.round(v), sample: n.name, kind: 'gap' });
        }
      }
      const pad = al?.padding || n.padding;
      if (pad) for (const v of [pad.top, pad.right, pad.bottom, pad.left]) {
        if (v > 0) bump(spacing, String(Math.round(v)), { value: Math.round(v), sample: n.name, kind: 'padding' });
      }

      // ---- radii
      if (n.radius) {
        for (const c of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) {
          const v = Math.round(n.radius[c]);
          if (v > 0) bump(radii, String(v), { value: v, sample: n.name });
        }
      }

      // ---- shadows
      for (const e of n.effects || []) {
        const key = [e.type, e.hex, e.offsetX, e.offsetY, e.blur, e.spread].join('|');
        bump(shadows, key, { type: e.type, color: e.color, hex: e.hex, offsetX: e.offsetX, offsetY: e.offsetY, blur: e.blur, spread: e.spread, sample: n.name });
      }
    });
  }

  // ---- merge visually identical colours, keeping the most-used as canonical
  const colorList = [...colors.entries()]
    .map(([hex, v]) => ({ hex, rgb: hexToRgb(hex), count: v.count, roles: [...(v.roles || [])], samples: v.samples, weightedArea: v.weightedArea || 0 }))
    .sort((a, b) => b.count - a.count);

  const merged = [];
  for (const c of colorList) {
    const near = merged.find((m) => colorDistance(m.rgb, c.rgb) < mergeTolerance);
    if (near) {
      near.count += c.count;
      near.weightedArea += c.weightedArea;
      near.roles = [...new Set([...near.roles, ...c.roles])];
      near.mergedFrom = [...(near.mergedFrom || []), c.hex];
    } else merged.push({ ...c });
  }

  const usedNames = new Map();
  const palette = merged
    .filter((c) => c.count >= minCount || c.weightedArea > 50000 || c.roles.includes('text'))
    .sort((a, b) => b.count - a.count)
    .map((c) => {
      let name = colorName(c.hex, c.rgb);
      const n = (usedNames.get(name) || 0) + 1;
      usedNames.set(name, n);
      if (n > 1) name = `${name}-${n}`;
      return { name, hex: c.hex, rgb: { r: c.rgb.r, g: c.rgb.g, b: c.rgb.b }, count: c.count, roles: c.roles, mergedFrom: c.mergedFrom || [], samples: c.samples };
    });

  // ---- type scale, named by size rank with the most-used size as body
  const typeList = [...typography.values()].filter((t) => t.count >= Math.max(1, minCount - 1)).sort((a, b) => b.size - a.size || b.count - a.count);
  // Anchor "body" to the real reading band. Pages that embed UI mockups are full
  // of 9-10px chrome text, which would otherwise drag the whole scale down.
  const all = [...typography.values()];
  const inBand = all.filter((t) => t.size >= 12 && t.size <= 24).sort((a, b) => b.count - a.count);
  const bodySize = (inBand[0] || all.sort((a, b) => b.count - a.count)[0])?.size ?? 16;
  let headingIx = 0, bodyIx = 0, captionIx = 0;
  const typeScale = typeList.map((t) => {
    let name;
    if (t.size >= bodySize * 2.4) name = 'display';
    else if (t.size > bodySize * 1.1) name = `heading/${++headingIx}`;
    else if (t.size >= bodySize * 0.92) name = bodyIx === 0 ? (++bodyIx, 'body/base') : `body/${++bodyIx}`;
    else name = captionIx === 0 ? (++captionIx, 'caption') : `caption/${++captionIx}`;
    const n = (usedNames.get(name) || 0) + 1;
    usedNames.set(name, n);
    if (n > 1) name = `${name}-${n}`;
    return {
      name, family: t.family, size: t.size, weight: t.weight, italic: t.italic,
      lineHeight: modeOf(t.lineHeights) == null ? null : { unit: 'PIXELS', value: modeOf(t.lineHeights) },
      letterSpacing: modeOf(t.letterSpacings) ? { unit: 'PIXELS', value: modeOf(t.letterSpacings) } : null,
      lineHeightVariants: t.lineHeights ? t.lineHeights.size : 1,
      transform: t.transform,
      count: t.count, sample: t.samples[0] || t.sample || '',
    };
  });

  // ---- spacing scale
  const spaceList = [...spacing.values()].filter((s) => s.count >= minCount).sort((a, b) => a.value - b.value);
  // Infer the layout grid: whichever unit the most weighted usage divides into.
  let baseUnit = 8, bestScore = -1;
  for (const unit of [4, 8, 6, 5, 10, 12]) {
    const score = spaceList.reduce((acc, s) => acc + (s.value % unit === 0 ? s.count : -s.count * 0.25), 0);
    if (score > bestScore) { bestScore = score; baseUnit = unit; }
  }
  const spaceScale = spaceList.map((s, i) => ({
    name: `space/${s.value}`, value: s.value, count: s.count, rank: i,
    onGrid: s.value % baseUnit === 0,
    steps: s.value / baseUnit,
  }));

  const RADIUS_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'];
  const radiusList = [...radii.values()].filter((r) => r.count >= minCount).sort((a, b) => a.value - b.value);
  const PILL = 100; // anything this round is a pill/circle, not a scale step
  const pills = radiusList.filter((r) => r.value >= PILL);
  const steps = radiusList.filter((r) => r.value < PILL);
  const radiusTaken = new Map();
  const radiusScale = steps.map((r, i) => {
    const base = `radius/${RADIUS_NAMES[Math.min(i, RADIUS_NAMES.length - 1)]}`;
    const seen = (radiusTaken.get(base) || 0) + 1;
    radiusTaken.set(base, seen);
    return { name: seen === 1 ? base : `${base}-${r.value}`, value: r.value, count: r.count, pill: false };
  });
  if (pills.length) {
    // 50% radii resolve to a different px value per element — one token, not N.
    radiusScale.push({ name: 'radius/full', value: 9999, count: pills.reduce((a, r) => a + r.count, 0), pill: true,
      note: `collapsed from ${pills.length} resolved value(s): ${pills.map((r) => r.value + 'px').join(', ')}` });
  }

  const SHADOW_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
  const shadowList = [...shadows.values()].filter((s) => s.count >= minCount)
    .sort((a, b) => (a.blur + Math.abs(a.offsetY)) - (b.blur + Math.abs(b.offsetY)));
  const shadowScale = shadowList.map((s, i) => ({
    name: `shadow/${SHADOW_NAMES[Math.min(i, SHADOW_NAMES.length - 1)]}${i >= SHADOW_NAMES.length ? `-${i}` : ''}`,
    type: s.type, color: s.color, hex: s.hex, offsetX: s.offsetX, offsetY: s.offsetY, blur: s.blur, spread: s.spread, count: s.count,
  }));

  const fonts = [...fontFamilies.values()].map((f) => ({ family: f.family, weight: f.weight, italic: f.italic, count: f.count }))
    .sort((a, b) => b.count - a.count);

  const tokens = {
    generatedAt: new Date().toISOString(),
    sources,
    summary: {
      colors: palette.length, textStyles: typeScale.length, spacing: spaceScale.length,
      radii: radiusScale.length, shadows: shadowScale.length, fontFamilies: [...new Set(fonts.map((f) => f.family))],
      baseUnit,
    },
    recommended: {
      note: 'Start from these when building Figma variables; the full lists below keep every observed value.',
      colors: palette.slice(0, 16).map((c) => c.name),
      typography: (() => {
        const big = typeScale.filter((t) => /^(display|heading)/.test(t.name) && t.count >= 2);
        const small = typeScale.filter((t) => !/^(display|heading)/.test(t.name) && t.count >= 2)
          .sort((a, b) => b.count - a.count).slice(0, 5);
        return [...big, ...small].sort((a, b) => b.size - a.size).slice(0, 14).map((t) => t.name);
      })(),
      spacing: spaceScale.filter((s) => s.onGrid).sort((a, b) => b.count - a.count).slice(0, 10).sort((a, b) => a.value - b.value).map((s) => s.value),
    },
    colors: palette,
    typography: typeScale,
    spacing: spaceScale,
    radii: radiusScale,
    shadows: shadowScale,
    fonts,
  };

  const outPath = out ? resolve(out) : join(dirname(resolve(files[0])), 'tokens.json');
  await writeFile(outPath, JSON.stringify(tokens, null, 2), 'utf8');
  process.stderr.write(`figma-forge: tokens -> ${outPath}\n`);
  console.log(JSON.stringify({ out: outPath, ...tokens.summary }, null, 2));
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
