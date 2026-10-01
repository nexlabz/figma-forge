#!/usr/bin/env node
/**
 * figma-forge — design tree -> Figma Plugin API script.
 *
 * Emits JavaScript to paste into the `use_figma` MCP tool. Output is a small
 * interpreter plus a compact node array, so even large pages stay reviewable
 * and well under the tool's payload limit.
 *
 * Usage:
 *   node scripts/to-figma-script.mjs <design.json> [options]
 *
 * Options:
 *   --list-sections      Print the page's top-level sections and exit
 *   --section <n>        Emit only section n (0-based; repeatable, or "0-3")
 *   --out <file>         Write to a file instead of stdout
 *   --root-name <name>   Name of the frame in Figma (default: <host> — <viewport>)
 *   --page <name>        Figma page to build on (default: derived from the URL path)
 *   --x <n> --y <n>      Explicit canvas position; omit --x to auto-place right of existing frames
 *   --auto-layout        Apply auto-layout where the page used flex/grid
 *   --max-bytes <n>      Warn above this script size (default 49000)
 *   --inline-svg-max <n> Inline SVGs up to this many bytes (default 8000)
 *   --chunk-size <n>     Max nodes per section (default 350)
 *   --section-bytes <n>  Max payload bytes per section (default 38000; use_figma's limit is 50000 total)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

function parseArgs(argv) {
  const o = { sections: null, x: null, y: 0, maxBytes: 49000, inlineSvgMax: 4000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], take = () => argv[++i];
    if (a === '--list-sections') o.list = true;
    else if (a === '--section') {
      const v = take();
      o.sections ||= [];
      if (v.includes('-')) { const [s, e] = v.split('-').map(Number); for (let k = s; k <= e; k++) o.sections.push(k); }
      else o.sections.push(Number(v));
    }
    else if (a === '--out') o.out = take();
    else if (a === '--root-name') o.rootName = take();
    else if (a === '--page') o.page = take();
    else if (a === '--x') o.x = Number(take());
    else if (a === '--y') o.y = Number(take());
    else if (a === '--auto-layout') o.autoLayout = true;
    else if (a === '--max-bytes') o.maxBytes = Number(take());
    else if (a === '--inline-svg-max') o.inlineSvgMax = Number(take());
    else if (a === '--chunk-size') o.chunkSize = Number(take());
    else if (a === '--section-bytes') o.sectionBytes = Number(take());
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else rest.push(a);
  }
  o.file = rest[0];
  return o;
}

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** One Figma page per website page: "/" -> Home, "/solutions/ci-cd" -> Solutions / Ci cd */
function pageNameFromUrl(u) {
  try {
    const { pathname } = new URL(u);
    const parts = pathname.split('/').filter(Boolean);
    if (!parts.length) return 'Home';
    return parts
      .map((seg) => seg.replace(/\.\w+$/, '').replace(/[-_+]+/g, ' ').trim())
      .filter(Boolean)
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join(' / ')
      .slice(0, 80) || 'Home';
  } catch { return 'Page'; }
}

function rgb(c) { return { r: r2(c.r), g: r2(c.g), b: r2(c.b) }; }

/**
 * Split the page into buildable chunks.
 *
 * Every node carries absolute page coordinates and `build()` re-derives child
 * offsets from its parent, so a deep subtree can be emitted as a top-level unit
 * and still land in exactly the right place. That lets a chunk boundary fall
 * anywhere in the tree instead of only between the body's direct children.
 * Document order is preserved, so paint order (z-index) survives the split.
 */
function splitUnits(node, max, out) {
  if (countNodes(node) <= max) { out.push(node); return; }
  out.push({ ...node, children: [] });           // the container itself
  for (const k of node.children || []) splitUnits(k, max, out);
}

function unitsOf(tree, maxNodes) {
  const top = (tree.children && tree.children.length) ? tree.children : [tree];
  const units = [];
  for (const n of top) splitUnits(n, maxNodes, units);
  return units;
}

/** Group compacted units into sections bounded by BOTH node count and payload bytes. */
function groupSections(units, maxNodes, maxBytes) {
  const out = [];
  let bucket = [], count = 0, bytes = 0;
  for (const u of units) {
    if (bucket.length && (count + u.nodes > maxNodes || bytes + u.bytes > maxBytes)) {
      out.push({ title: bucket[0].title, units: bucket, nodes: count, bytes });
      bucket = []; count = 0; bytes = 0;
    }
    bucket.push(u); count += u.nodes; bytes += u.bytes;
  }
  if (bucket.length) out.push({ title: bucket[0].title, units: bucket, nodes: count, bytes });
  return out;
}

function countNodes(n) { let c = 1; for (const k of n.children || []) c += countNodes(k); return c; }
function boundsOf(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const r = n.rect; if (!r) continue;
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
  }
  return x0 === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// --------------------------------------------------------- node compaction
function compact(n, ctx) {
  const r = n.rect || { x: 0, y: 0, width: 0, height: 0 };
  const o = { n: (n.name || n.tag || 'Node').slice(0, 60), x: r2(r.x), y: r2(r.y), w: r2(Math.max(0, r.width)), h: r2(Math.max(0, r.height)) };
  if (n.opacity != null && n.opacity < 1) o.o = r2(n.opacity);

  switch (n.type) {
    case 'TEXT': {
      o.t = 'T';
      o.ch = n.characters || '';
      const f = n.font || {};
      o.fo = {
        fam: f.family || 'Inter', sz: r2(f.size || 16), wt: f.weight || 400, it: !!f.italic,
        al: (f.align || 'left').toUpperCase(),
      };
      if (f.lineHeight?.value) o.fo.lh = r2(f.lineHeight.value);
      if (f.letterSpacing?.value) o.fo.ls = r2(f.letterSpacing.value);
      if (f.color) o.fo.c = rgb(f.color);
      if (f.color && f.color.a < 1) o.fo.ca = r2(f.color.a);
      if (f.transform && f.transform !== 'none') o.fo.tc = f.transform;
      if (f.decoration && f.decoration !== 'none') o.fo.td = f.decoration;
      if (n.styleRuns?.length) {
        o.ru = n.styleRuns.slice(0, 40).map((s) => {
          const q = { s: s.start, e: s.end };
          if (s.family) q.fam = s.family;
          if (s.weight) q.wt = s.weight;
          if (s.size) q.sz = r2(s.size);
          if (s.color) { q.c = rgb(s.color); if (s.color.a < 1) q.ca = r2(s.color.a); }
          if (s.decoration && s.decoration !== 'none') q.td = s.decoration;
          return q;
        });
      }
      break;
    }
    case 'IMAGE': {
      o.t = 'I';
      const a = ctx.assetsById[n.image?.assetId];
      o.img = { id: n.image?.assetId || null, file: a?.file || null, fit: n.image?.objectFit || 'fill' };
      if (n.image?.alt) o.n = n.image.alt.slice(0, 60);
      break;
    }
    case 'VECTOR': {
      const a = ctx.assetsById[n.svg?.assetId];
      const inline = a && a.file && ctx.svgCache[a.file] !== undefined ? ctx.svgCache[a.file] : null;
      if (inline) { o.t = 'S'; o.svg = inline; }
      else { o.t = 'I'; o.img = { id: n.svg?.assetId || null, file: a?.file || null, fit: 'contain', vector: true }; }
      break;
    }
    case 'INPUT': o.t = 'F'; o.ph = n.input?.placeholder || null; break;
    case 'PLACEHOLDER': o.t = 'F'; o.pk = n.placeholderKind || 'embed'; break;
    case 'RECT': o.t = 'R'; break;
    default: o.t = 'F';
  }

  if (n.fill?.color) { o.f = rgb(n.fill.color); if (n.fill.color.a < 1) o.fa = r2(n.fill.color.a); }
  for (const layer of n.backgroundLayers || []) {
    if (layer.kind === 'gradient' && layer.gradient?.stops?.length >= 2) {
      o.g = {
        k: layer.gradient.type, a: r2(layer.gradient.angle ?? 180),
        st: layer.gradient.stops.map((s) => ({ p: r2(s.position), c: rgb(s.color), a: r2(s.color.a ?? 1) })),
      };
      break; // Figma paints one gradient per fill slot; the first wins
    }
  }
  if (n.radius) {
    const q = n.radius;
    o.r = q.uniform ? r2(q.topLeft) : [r2(q.topLeft), r2(q.topRight), r2(q.bottomRight), r2(q.bottomLeft)];
  }
  if (n.border) {
    const b = n.border;
    const first = b.top || b.right || b.bottom || b.left;
    if (first) {
      o.sk = { c: rgb(first.color), a: r2(first.color.a ?? 1) };
      if (b.uniform) o.sk.w = r2(first.width);
      else o.sk.sides = [r2(b.top?.width || 0), r2(b.right?.width || 0), r2(b.bottom?.width || 0), r2(b.left?.width || 0)];
      if (first.style === 'dashed') o.sk.d = [6, 4];
      else if (first.style === 'dotted') o.sk.d = [2, 3];
    }
  }
  if (n.effects?.length) {
    o.e = n.effects.slice(0, 6).map((e) => ({
      t: e.type, c: rgb(e.color), a: r2(e.color.a ?? 1),
      x: r2(e.offsetX), y: r2(e.offsetY), b: r2(Math.max(0, e.blur)), s: r2(e.spread || 0),
    }));
  }
  if (n.clipsContent) o.cl = 1;
  if (ctx.autoLayout && n.autoLayout && n.autoLayout.mode !== 'GRID') {
    const al = n.autoLayout;
    o.al = {
      m: al.mode, g: r2(al.itemSpacing || 0),
      p: [r2(al.padding?.top || 0), r2(al.padding?.right || 0), r2(al.padding?.bottom || 0), r2(al.padding?.left || 0)],
      j: al.justifyContent, a: al.alignItems,
    };
  }
  const kids = (n.children || []).map((k) => compact(k, ctx)).filter(Boolean);
  if (kids.length) o.k = kids;
  return o;
}

// ------------------------------------------------------- emitted interpreter
const RUNTIME = String.raw`
// ---- figma-forge runtime -------------------------------------------------
const created = [];
const warn = [];

// CSS angle (0deg = up, clockwise) -> Figma gradientTransform, rotating about the centre.
function gradTransform(cssAngle) {
  const a = (cssAngle - 90) * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [[c, s, 0.5 - c * 0.5 - s * 0.5], [-s, c, 0.5 + s * 0.5 - c * 0.5]];
}

function solid(c, a) { const p = { type: 'SOLID', color: c }; if (a != null && a < 1) p.opacity = a; return p; }

function paintsFor(d) {
  const out = [];
  if (d.f) out.push(solid(d.f, d.fa));
  if (d.g) {
    const type = d.g.k === 'GRADIENT_RADIAL' ? 'GRADIENT_RADIAL' : d.g.k === 'GRADIENT_ANGULAR' ? 'GRADIENT_ANGULAR' : 'GRADIENT_LINEAR';
    out.push({
      type,
      gradientTransform: gradTransform(d.g.a),
      gradientStops: d.g.st.map(s => ({ position: Math.max(0, Math.min(1, s.p)), color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.a == null ? 1 : s.a } })),
    });
  }
  return out;
}

// ---- font resolution: web fonts rarely exist in Figma, so map by weight ----
const WEIGHT_NAMES = {
  100: ['Thin'], 200: ['Extra Light', 'ExtraLight', 'UltraLight'], 300: ['Light'],
  400: ['Regular', 'Book', 'Normal'], 500: ['Medium'], 600: ['Semi Bold', 'SemiBold', 'Demi Bold'],
  700: ['Bold'], 800: ['Extra Bold', 'ExtraBold', 'Ultra Bold'], 900: ['Black', 'Heavy'],
};
const availableFonts = await figma.listAvailableFontsAsync();
const byFamily = new Map();
for (const f of availableFonts) {
  if (!byFamily.has(f.fontName.family)) byFamily.set(f.fontName.family, []);
  byFamily.get(f.fontName.family).push(f.fontName.style);
}
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
const normFamilies = new Map();
for (const fam of byFamily.keys()) normFamilies.set(norm(fam), fam);

const FALLBACKS = ['Inter', 'Roboto', 'Helvetica Neue', 'Arial', 'SF Pro Text'];
const fontCache = new Map();
function resolveFont(family, weight, italic) {
  const key = family + '|' + weight + '|' + italic;
  if (fontCache.has(key)) return fontCache.get(key);
  let fam = normFamilies.get(norm(family));
  if (!fam) {
    // strip common web-font suffixes: "sohne-var" -> "sohne"
    const base = norm(family).replace(/(var|variable|vf|web|display|text)$/, '');
    fam = normFamilies.get(base);
  }
  if (!fam) { for (const fb of FALLBACKS) { if (byFamily.has(fb)) { fam = fb; break; } } }
  if (!fam) fam = availableFonts[0].fontName.family;

  const styles = byFamily.get(fam) || ['Regular'];
  const wanted = WEIGHT_NAMES[Math.round(weight / 100) * 100] || ['Regular'];
  const want = italic ? wanted.map(w => w + ' Italic').concat(wanted) : wanted;
  let style = null;
  for (const w of want) { const hit = styles.find(s => norm(s) === norm(w)); if (hit) { style = hit; break; } }
  if (!style && italic) style = styles.find(s => /italic/i.test(s));
  if (!style) style = styles.find(s => norm(s) === 'regular') || styles[0];
  const resolved = { family: fam, style };
  if (norm(fam) !== norm(family)) warn.push('font ' + family + ' ' + weight + ' -> ' + fam + ' ' + style);
  fontCache.set(key, resolved);
  return resolved;
}

// Collect and load every font the payload needs, once, before any text is made.
const needed = new Map();
(function scan(list) {
  for (const d of list) {
    if (d.t === 'T' && d.fo) {
      const f = resolveFont(d.fo.fam, d.fo.wt, d.fo.it);
      needed.set(f.family + '|' + f.style, f);
      for (const r of d.ru || []) {
        const rf = resolveFont(r.fam || d.fo.fam, r.wt || d.fo.wt, d.fo.it);
        needed.set(rf.family + '|' + rf.style, rf);
      }
    }
    if (d.k) scan(d.k);
  }
})(NODES);
for (const f of needed.values()) {
  try { await figma.loadFontAsync(f); }
  catch (e) { warn.push('font load failed: ' + f.family + ' ' + f.style); }
}

// ---- builders -------------------------------------------------------------
function applyBox(node, d) {
  if (d.r != null) {
    if (Array.isArray(d.r)) {
      node.topLeftRadius = d.r[0]; node.topRightRadius = d.r[1];
      node.bottomRightRadius = d.r[2]; node.bottomLeftRadius = d.r[3];
    } else node.cornerRadius = d.r;
  }
  if (d.sk) {
    node.strokes = [solid(d.sk.c, d.sk.a)];
    node.strokeAlign = 'INSIDE';
    if (d.sk.sides) {
      node.strokeTopWeight = d.sk.sides[0]; node.strokeRightWeight = d.sk.sides[1];
      node.strokeBottomWeight = d.sk.sides[2]; node.strokeLeftWeight = d.sk.sides[3];
    } else node.strokeWeight = Math.max(0.01, d.sk.w || 1);
    if (d.sk.d) node.dashPattern = d.sk.d;
  }
  if (d.e) {
    node.effects = d.e.map(e => ({
      type: e.t === 'INNER_SHADOW' ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: e.c.r, g: e.c.g, b: e.c.b, a: e.a == null ? 1 : e.a },
      offset: { x: e.x, y: e.y }, radius: e.b, spread: e.s,
      visible: true, blendMode: 'NORMAL',
    }));
  }
  if (d.o != null) node.opacity = d.o;
}

function makeText(d) {
  const t = figma.createText();
  const f = resolveFont(d.fo.fam, d.fo.wt, d.fo.it);
  t.fontName = f;
  t.characters = d.ch || ' ';
  t.fontSize = Math.max(1, d.fo.sz);
  if (d.fo.c) t.fills = [solid(d.fo.c, d.fo.ca)];
  if (d.fo.lh) t.lineHeight = { unit: 'PIXELS', value: d.fo.lh };
  if (d.fo.ls) t.letterSpacing = { unit: 'PIXELS', value: d.fo.ls };
  const align = { LEFT: 'LEFT', RIGHT: 'RIGHT', CENTER: 'CENTER', JUSTIFY: 'JUSTIFIED', START: 'LEFT', END: 'RIGHT' }[d.fo.al] || 'LEFT';
  t.textAlignHorizontal = align;
  if (d.fo.tc === 'uppercase') t.textCase = 'UPPER';
  else if (d.fo.tc === 'lowercase') t.textCase = 'LOWER';
  else if (d.fo.tc === 'capitalize') t.textCase = 'TITLE';
  if (d.fo.td === 'underline') t.textDecoration = 'UNDERLINE';
  else if (d.fo.td === 'line-through') t.textDecoration = 'STRIKETHROUGH';

  // Fixed width + HEIGHT autoresize reproduces the page's line breaks.
  if (d.w >= 1) { t.resize(Math.max(1, d.w), Math.max(1, d.h || 1)); t.textAutoResize = 'HEIGHT'; }
  else t.textAutoResize = 'WIDTH_AND_HEIGHT';

  for (const r of d.ru || []) {
    const s = Math.max(0, Math.min(r.s, t.characters.length));
    const e = Math.max(s, Math.min(r.e, t.characters.length));
    if (e <= s) continue;
    try {
      if (r.fam || r.wt) t.setRangeFontName(s, e, resolveFont(r.fam || d.fo.fam, r.wt || d.fo.wt, d.fo.it));
      if (r.sz) t.setRangeFontSize(s, e, r.sz);
      if (r.c) t.setRangeFills(s, e, [solid(r.c, r.ca)]);
      if (r.td === 'underline') t.setRangeTextDecoration(s, e, 'UNDERLINE');
      else if (r.td === 'line-through') t.setRangeTextDecoration(s, e, 'STRIKETHROUGH');
    } catch (err) { warn.push('range style failed on "' + String(d.n).slice(0, 24) + '": ' + err.message); }
  }
  return t;
}

function build(d, parent, ox, oy) {
  let node;
  if (d.t === 'T') node = makeText(d);
  else if (d.t === 'R') { node = figma.createRectangle(); node.resize(Math.max(0.01, d.w), Math.max(0.01, d.h)); }
  else if (d.t === 'S') {
    try { node = figma.createNodeFromSvg(d.svg); node.resize(Math.max(0.01, d.w), Math.max(0.01, d.h)); }
    catch (e) { node = figma.createRectangle(); node.resize(Math.max(0.01, d.w), Math.max(0.01, d.h)); node.fills = []; warn.push('svg parse failed: ' + d.n); }
  }
  else if (d.t === 'I') {
    // Placeholder — swap in the real bitmap after upload_assets returns a hash.
    node = figma.createRectangle();
    node.resize(Math.max(0.01, d.w), Math.max(0.01, d.h));
    node.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.91, b: 0.93 } }];
    node.name = 'IMG:' + (d.img && d.img.id ? d.img.id : '?') + ' ' + d.n;
  }
  else {
    node = figma.createFrame();
    node.resize(Math.max(0.01, d.w), Math.max(0.01, d.h));
    node.fills = [];
    node.clipsContent = !!d.cl;
  }

  if (d.t !== 'T' && d.t !== 'S') {
    const p = paintsFor(d);
    if (p.length) node.fills = p;
    else if (d.t === 'F') node.fills = [];
  }
  if (d.t !== 'T') applyBox(node, d);
  if (d.n && !node.name.startsWith('IMG:')) node.name = d.n;

  parent.appendChild(node);
  node.x = d.x - ox;
  node.y = d.y - oy;
  created.push(node.id);

  for (const k of d.k || []) build(k, node, d.x, d.y);

  // Auto-layout is applied after children exist, or HUG/FILL are rejected.
  if (d.al && 'layoutMode' in node) {
    try {
      node.layoutMode = d.al.m === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
      node.itemSpacing = d.al.g;
      node.paddingTop = d.al.p[0]; node.paddingRight = d.al.p[1];
      node.paddingBottom = d.al.p[2]; node.paddingLeft = d.al.p[3];
      node.primaryAxisSizingMode = 'FIXED';
      node.counterAxisSizingMode = 'FIXED';
      const J = { 'flex-start': 'MIN', 'flex-end': 'MAX', center: 'CENTER', 'space-between': 'SPACE_BETWEEN', start: 'MIN', end: 'MAX' };
      const A = { 'flex-start': 'MIN', 'flex-end': 'MAX', center: 'CENTER', stretch: 'MIN', baseline: 'MIN', start: 'MIN', end: 'MAX' };
      if (J[d.al.j]) node.primaryAxisAlignItems = J[d.al.j];
      if (A[d.al.a]) node.counterAxisAlignItems = A[d.al.a];
    } catch (e) { warn.push('auto-layout failed on ' + d.n + ': ' + e.message); }
  }
  return node;
}

// ---- target page: one Figma page per website page --------------------------
// Page context resets to the first page on every use_figma call, so re-select
// it here. Switch at most once per call.
let page = figma.root.children.find(p => p.name === FIGMA_PAGE);
let pageCreated = false;
if (!page) { page = figma.createPage(); page.name = FIGMA_PAGE; pageCreated = true; }
if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);

// ---- root frame: reused across sections so the page builds up in place ----
// Every viewport of the same website page lives here, side by side.
let root = figma.currentPage.findOne(n => n.type === 'FRAME' && n.name === ROOT_NAME);
if (!root) {
  root = figma.createFrame();
  root.name = ROOT_NAME;
  root.resize(Math.max(1, PAGE.w), Math.max(1, PAGE.h));
  if (PAGE.x === null) {
    // Auto-place to the right of whatever is already on this page.
    let right = null;
    for (const c of figma.currentPage.children) {
      if (c.id === root.id) continue;
      right = right === null ? c.x + c.width : Math.max(right, c.x + c.width);
    }
    root.x = right === null ? 0 : right + 160;
  } else root.x = PAGE.x;
  root.y = PAGE.y;
  root.fills = [solid(PAGE.bg, 1)];
  root.clipsContent = true;
  figma.currentPage.appendChild(root);
  created.push(root.id);
}

for (const d of NODES) build(d, root, 0, 0);

return {
  section: SECTION,
  figmaPage: { name: page.name, id: page.id, created: pageCreated },
  rootId: root.id,
  rootName: ROOT_NAME,
  rootX: root.x,
  createdNodeIds: created.slice(0, 400),
  createdCount: created.length,
  fontWarnings: [...new Set(warn)].slice(0, 25),
};
`;

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }
  if (args.help || !args.file) {
    const src = await readFile(new URL(import.meta.url), 'utf8');
    console.log(src.split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
    process.exit(args.file ? 0 : 2);
  }

  const file = resolve(args.file);
  const data = JSON.parse(await readFile(file, 'utf8'));
  const baseDir = dirname(file);
  const assetsById = Object.fromEntries((data.assets || []).map((a) => [a.id, a]));

  // Inline small SVGs straight into the script; larger ones stay placeholders.
  const svgCache = {};
  for (const a of data.assets || []) {
    if (a.kind !== 'svg' || !a.file) continue;
    const p = join(baseDir, a.file);
    if (!existsSync(p)) continue;
    const txt = await readFile(p, 'utf8');
    if (txt.length <= args.inlineSvgMax) svgCache[a.file] = txt;
  }

  const ctx = { assetsById, svgCache, autoLayout: !!args.autoLayout };
  const maxNodes = args.chunkSize || 350;
  const maxBytes = args.sectionBytes || 38000;  // use_figma caps `code` at 50000 chars; the runtime takes ~7.6KB

  const makeUnit = (raw) => {
    const c = compact(raw, ctx);
    return { title: raw.name || 'Section', raw, data: c, nodes: countNodes(raw), bytes: JSON.stringify(c).length, rect: raw.rect };
  };

  // Node count alone misses payload weight — one 350-node unit full of inline
  // SVG can outweigh three plain ones. Split oversized units down the tree.
  const units = [];
  const oversized = [];
  for (const raw of unitsOf(data.tree, maxNodes)) {
    (function go(u, depth) {
      if (u.bytes <= maxBytes || depth > 10) { units.push(u); return; }
      if (!u.raw.children || !u.raw.children.length) { oversized.push(u); units.push(u); return; }
      units.push(makeUnit({ ...u.raw, children: [] }));
      for (const k of u.raw.children) go(makeUnit(k), depth + 1);
    })(makeUnit(raw), 0);
  }
  if (oversized.length) {
    process.stderr.write(`figma-forge: ${oversized.length} indivisible node(s) exceed the byte budget (largest ${Math.max(...oversized.map((u) => u.bytes))}B) — usually a big inline SVG. Lower --inline-svg-max to push them to placeholders.\n`);
  }
  const sections = groupSections(units, maxNodes, maxBytes);

  if (args.list) {
    console.log(JSON.stringify({
      url: data.meta.url, viewport: data.meta.viewportPreset,
      page: data.meta.page, totalSections: sections.length,
      note: 'Emit one section per use_figma call, in order. estScriptBytes includes the ~7KB runtime.',
      sections: sections.map((sec, i) => {
        const b = boundsOf(sec.units.map((u) => u.rect).filter(Boolean).map((r) => ({ rect: r })));
        return { index: i, title: sec.title, units: sec.units.length, nodes: sec.nodes, estScriptBytes: sec.bytes + 7600, y: Math.round(b.y), height: Math.round(b.height) };
      }),
    }, null, 2));
    return;
  }

  const pick = args.sections ? sections.filter((_, i) => args.sections.includes(i)) : sections;
  if (!pick.length) { console.error(`No sections matched. The page has ${sections.length} (0-${sections.length - 1}).`); process.exit(2); }
  const nodes = pick.flatMap((sec) => sec.units.map((u) => u.data));

  const host = (() => { try { return new URL(data.meta.url).hostname.replace(/^www\./, ''); } catch { return 'page'; } })();
  const rootName = args.rootName || `${host} — ${data.meta.viewportPreset || 'desktop'}`;
  const figmaPage = args.page || pageNameFromUrl(data.meta.url);
  const bg = data.meta.background?.color || { r: 1, g: 1, b: 1 };
  const label = args.sections ? `section ${args.sections.join(',')} of ${sections.length}` : `all ${sections.length} sections`;

  const header = `// figma-forge — ${data.meta.url}
// ${label} · ${nodes.reduce((a, n) => a + countNodes({ children: n.k || [] }), nodes.length)} nodes · generated ${new Date().toISOString()}
const SECTION = ${JSON.stringify(args.sections || 'all')};
const ROOT_NAME = ${JSON.stringify(rootName)};
const FIGMA_PAGE = ${JSON.stringify(figmaPage)};
const PAGE = { x: ${args.x === null ? 'null' : args.x}, y: ${args.y}, w: ${Math.round(data.meta.page.width)}, h: ${Math.round(data.meta.page.height)}, bg: ${JSON.stringify(rgb(bg))} };
const NODES = ${JSON.stringify(nodes)};
`;
  const script = header + RUNTIME;

  if (args.out) {
    await writeFile(resolve(args.out), script, 'utf8');
    process.stderr.write(`figma-forge: wrote ${resolve(args.out)} (${script.length} bytes)\n`);
  } else {
    process.stdout.write(script);
  }
  if (script.length > args.maxBytes) {
    process.stderr.write(`\nWARNING: script is ${script.length} chars — use_figma rejects code over 50000. Re-run with a smaller --section-bytes.\n`);
  }
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
