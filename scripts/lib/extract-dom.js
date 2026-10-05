/**
 * In-page extractor. Serialized to a string and evaluated inside the target page.
 * Walks the rendered DOM and emits a Figma-shaped design tree: absolute geometry,
 * resolved paints, text runs, auto-layout hints and asset references.
 *
 * Must stay self-contained — no imports, no page globals beyond the DOM.
 */
(function extractDesignTree(opts) {
  var MAX_NODES = opts.maxNodes || 4000;
  var MAX_DEPTH = opts.maxDepth || 32;
  var PRUNE = opts.prune !== false;
  var KEEP_HIDDEN = opts.keepHidden === true;
  var INCLUDE_PSEUDO = opts.includePseudo !== false;
  var MIN_SIZE = 1; // px — below this an element contributes nothing visible

  var nodeCount = 0;
  var truncated = false;
  var assets = [];
  var assetSeen = Object.create(null);
  var warnings = [];

  // ---------------------------------------------------------------- colors
  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  function parseColor(str) {
    if (!str) return null;
    str = str.trim();
    if (str === 'transparent' || str === 'none') return null;
    var m = str.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var parts = m[1].split(/[,\/\s]+/).filter(function (p) { return p !== ''; });
      var r = parseFloat(parts[0]), g = parseFloat(parts[1]), b = parseFloat(parts[2]);
      var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
      if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
      if (String(parts[3] || '').indexOf('%') >= 0) a = a / 100;
      return { r: clamp01(r / 255), g: clamp01(g / 255), b: clamp01(b / 255), a: isNaN(a) ? 1 : clamp01(a) };
    }
    // color(srgb r g b / a) — emitted for wide-gamut declarations
    m = str.match(/^color\(\s*srgb\s+([^)]+)\)$/i);
    if (m) {
      var p = m[1].split(/[\s\/]+/).filter(function (x) { return x !== ''; });
      var a2 = p.length > 3 ? parseFloat(p[3]) : 1;
      return { r: clamp01(parseFloat(p[0])), g: clamp01(parseFloat(p[1])), b: clamp01(parseFloat(p[2])), a: isNaN(a2) ? 1 : clamp01(a2) };
    }
    if (str.charAt(0) === '#') {
      var hex = str.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16) / 255,
          g: parseInt(hex.slice(2, 4), 16) / 255,
          b: parseInt(hex.slice(4, 6), 16) / 255,
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
      }
    }
    return null;
  }

  function hex(c) {
    if (!c) return null;
    function h(v) { var s = Math.round(clamp01(v) * 255).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h(c.r) + h(c.g) + h(c.b) + (c.a != null && c.a < 1 ? h(c.a) : '');
  }

  // ------------------------------------------------------------- gradients
  // Splits on top-level commas only, so rgba(…) and nested functions survive.
  function splitTopLevel(str, sep) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim() !== '') out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseGradient(str, w, h) {
    var m = str.match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/i);
    if (!m) return null;
    var kind = m[2].toLowerCase();
    var parts = splitTopLevel(m[3], ',');
    var angleDeg = 180; // CSS default: top -> bottom
    var first = parts[0] || '';

    if (kind === 'linear') {
      var am = first.match(/^([-\d.]+)deg$/i);
      var tm = first.match(/^to\s+(.+)$/i);
      if (am) { angleDeg = parseFloat(am[1]); parts = parts.slice(1); }
      else if (tm) {
        var dir = tm[1].trim().toLowerCase().split(/\s+/).sort().join(' ');
        var map = { top: 0, right: 90, bottom: 180, left: 270, 'right top': 45, 'bottom right': 135, 'bottom left': 225, 'left top': 315 };
        if (map[dir] !== undefined) angleDeg = map[dir];
        parts = parts.slice(1);
      } else if (/^(turn|rad|grad)/.test(first) || /^[-\d.]+(turn|rad|grad)$/i.test(first)) {
        var rm = first.match(/^([-\d.]+)(turn|rad|grad)$/i);
        if (rm) {
          var v = parseFloat(rm[1]);
          angleDeg = rm[2] === 'turn' ? v * 360 : rm[2] === 'rad' ? (v * 180) / Math.PI : v * 0.9;
          parts = parts.slice(1);
        }
      }
    } else if (/^(circle|ellipse|at |closest|farthest)/i.test(first)) {
      parts = parts.slice(1);
    }

    var stops = [];
    for (var i = 0; i < parts.length; i++) {
      var sp = parts[i];
      var cm = sp.match(/^(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s*(.*)$/i);
      if (!cm) continue;
      var col = parseColor(cm[1]);
      if (!col) continue;
      var posStr = (cm[2] || '').trim().split(/\s+/)[0];
      var pos = null;
      if (posStr) {
        if (posStr.indexOf('%') >= 0) pos = parseFloat(posStr) / 100;
        else if (posStr.indexOf('px') >= 0) {
          var span = kind === 'linear' ? Math.max(w, h) : Math.max(w, h) / 2;
          pos = span ? parseFloat(posStr) / span : null;
        }
      }
      stops.push({ color: col, position: pos });
    }
    if (stops.length < 2) return null;
    // Fill in implicit positions by even distribution between known anchors.
    if (stops[0].position == null) stops[0].position = 0;
    if (stops[stops.length - 1].position == null) stops[stops.length - 1].position = 1;
    for (var j = 1; j < stops.length - 1; j++) {
      if (stops[j].position == null) {
        var prev = j - 1; while (stops[prev].position == null) prev--;
        var next = j + 1; while (next < stops.length && stops[next].position == null) next++;
        var step = (stops[next].position - stops[prev].position) / (next - prev);
        stops[j].position = stops[prev].position + step * (j - prev);
      }
    }
    return {
      type: kind === 'linear' ? 'GRADIENT_LINEAR' : kind === 'radial' ? 'GRADIENT_RADIAL' : 'GRADIENT_ANGULAR',
      angle: angleDeg,
      repeating: !!m[1],
      stops: stops.map(function (s) { return { color: s.color, hex: hex(s.color), position: clamp01(s.position) }; }),
    };
  }

  // ---------------------------------------------------------------- assets
  function absUrl(u) {
    if (!u) return null;
    try { return new URL(u, document.baseURI).href; } catch (e) { return u; }
  }

  function addAsset(a) {
    var key = a.kind + '|' + (a.url || a.svg || '');
    if (assetSeen[key]) return assetSeen[key];
    var id = 'asset-' + (assets.length + 1);
    a.id = id;
    assets.push(a);
    assetSeen[key] = id;
    return id;
  }

  function bgImageLayers(style, w, h) {
    var raw = style.backgroundImage;
    if (!raw || raw === 'none') return [];
    var layers = splitTopLevel(raw, ',');
    var out = [];
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var g = parseGradient(l, w, h);
      if (g) { out.push({ kind: 'gradient', gradient: g }); continue; }
      var um = l.match(/^url\((['"]?)(.*?)\1\)$/i);
      if (um) {
        var url = absUrl(um[2]);
        if (url && url.indexOf('data:') !== 0) {
          out.push({ kind: 'image', assetId: addAsset({ kind: 'image', url: url, source: 'background-image' }), url: url });
        } else if (url) {
          out.push({ kind: 'image', assetId: addAsset({ kind: 'image', url: url, inline: true, source: 'background-image' }), inline: true });
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------- borders
  var SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  function readBorders(style) {
    var b = {}, uniform = true, ref = null, any = false;
    for (var i = 0; i < SIDES.length; i++) {
      var s = SIDES[i];
      var wpx = parseFloat(style['border' + s + 'Width']) || 0;
      var st = style['border' + s + 'Style'];
      var col = parseColor(style['border' + s + 'Color']);
      var on = wpx > 0 && st !== 'none' && st !== 'hidden' && col && col.a > 0;
      b[s.toLowerCase()] = on ? { width: wpx, style: st, color: col, hex: hex(col) } : null;
      if (on) any = true;
      var sig = on ? wpx + '|' + st + '|' + hex(col) : 'none';
      if (ref === null) ref = sig; else if (ref !== sig) uniform = false;
    }
    if (!any) return null;
    return { uniform: uniform, sides: b, top: b.top, right: b.right, bottom: b.bottom, left: b.left };
  }

  function readRadius(style, w, h) {
    function one(v) {
      if (!v) return 0;
      var p = String(v).trim().split(/\s+/);
      var val = p[0];
      if (val.indexOf('%') >= 0) return (parseFloat(val) / 100) * Math.min(w, h);
      return parseFloat(val) || 0;
    }
    var tl = one(style.borderTopLeftRadius), tr = one(style.borderTopRightRadius);
    var br = one(style.borderBottomRightRadius), bl = one(style.borderBottomLeftRadius);
    if (!tl && !tr && !br && !bl) return null;
    return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl, uniform: tl === tr && tr === br && br === bl };
  }

  function readShadows(style) {
    var raw = style.boxShadow;
    if (!raw || raw === 'none') return null;
    var out = [];
    var layers = splitTopLevel(raw, ',');
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var inset = /\binset\b/.test(l);
      l = l.replace(/\binset\b/, '').trim();
      var cm = l.match(/^(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})\s*(.*)$/i);
      var color = null, rest = l;
      if (cm) { color = parseColor(cm[1]); rest = cm[2]; }
      var nums = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (nums.length < 2) continue;
      out.push({
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: color || { r: 0, g: 0, b: 0, a: 1 },
        hex: hex(color || { r: 0, g: 0, b: 0, a: 1 }),
        offsetX: nums[0], offsetY: nums[1], blur: nums[2] || 0, spread: nums[3] || 0,
      });
    }
    return out.length ? out : null;
  }

  // ------------------------------------------------------------ typography
  function readFont(style) {
    var fam = (style.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
    var lh = style.lineHeight;
    var lineHeight = null;
    if (lh && lh !== 'normal') {
      var n = parseFloat(lh);
      if (!isNaN(n)) lineHeight = { unit: 'PIXELS', value: n };
    }
    var ls = parseFloat(style.letterSpacing);
    return {
      family: fam || 'Inter',
      familyStack: style.fontFamily,
      size: parseFloat(style.fontSize) || 16,
      weight: parseInt(style.fontWeight, 10) || 400,
      style: style.fontStyle,
      lineHeight: lineHeight,
      letterSpacing: isNaN(ls) ? null : { unit: 'PIXELS', value: ls },
      align: style.textAlign,
      transform: style.textTransform,
      decoration: (style.textDecorationLine || style.textDecoration || 'none').split(' ')[0],
      color: parseColor(style.color),
      colorHex: hex(parseColor(style.color)),
      italic: style.fontStyle === 'italic' || style.fontStyle === 'oblique',
    };
  }

  // ------------------------------------------------------------- layout
  function readAutoLayout(style) {
    var d = style.display;
    var isFlex = d === 'flex' || d === 'inline-flex';
    var isGrid = d === 'grid' || d === 'inline-grid';
    if (!isFlex && !isGrid) return null;
    var dirRaw = style.flexDirection || 'row';
    var gapRow = parseFloat(style.rowGap) || 0;
    var gapCol = parseFloat(style.columnGap) || 0;
    var al = {
      source: isGrid ? 'grid' : 'flex',
      mode: isGrid ? 'GRID' : (dirRaw.indexOf('column') === 0 ? 'VERTICAL' : 'HORIZONTAL'),
      reverse: dirRaw.indexOf('reverse') > 0,
      wrap: style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse',
      itemSpacing: isGrid ? gapCol : (dirRaw.indexOf('column') === 0 ? gapRow : gapCol),
      counterAxisSpacing: isGrid ? gapRow : (dirRaw.indexOf('column') === 0 ? gapCol : gapRow),
      justifyContent: style.justifyContent,
      alignItems: style.alignItems,
      padding: {
        top: parseFloat(style.paddingTop) || 0,
        right: parseFloat(style.paddingRight) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
        left: parseFloat(style.paddingLeft) || 0,
      },
    };
    if (isGrid) {
      al.gridTemplateColumns = style.gridTemplateColumns;
      al.gridTemplateRows = style.gridTemplateRows;
      al.columnCount = (style.gridTemplateColumns || '').trim().split(/\s+/).filter(Boolean).length || null;
    }
    return al;
  }

  function cssPath(el) {
    var parts = [];
    var cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 6) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id) { seg += '#' + cur.id; parts.unshift(seg); break; }
      var cls = (cur.getAttribute && cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function nameFor(el, style) {
    var tag = el.tagName.toLowerCase();
    var aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-testid'));
    if (aria) return aria.slice(0, 40);
    if (el.id) return '#' + el.id;
    var cls = (el.getAttribute && el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    var semantic = { header: 'Header', nav: 'Nav', main: 'Main', footer: 'Footer', section: 'Section', article: 'Article', aside: 'Aside', form: 'Form', button: 'Button', a: 'Link', ul: 'List', ol: 'List', li: 'List item', table: 'Table', img: 'Image', svg: 'Icon', video: 'Video', input: 'Input', label: 'Label' };
    if (semantic[tag]) return semantic[tag];
    if (/^h[1-6]$/.test(tag)) return 'Heading ' + tag[1];
    if (cls) return cls.slice(0, 40);
    return tag;
  }

  // -------------------------------------------------------------- walking
  var docEl = document.documentElement;
  var pageWidth = Math.max(docEl.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth);
  var pageHeight = Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
  var sx = window.scrollX, sy = window.scrollY;

  function absRect(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height };
  }

  function textRunsOf(el, style) {
    var runs = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType !== 3) continue;
      var raw = n.nodeValue;
      if (!raw || !raw.replace(/\s+/g, ' ').trim()) continue;
      if (!isRenderable(el)) continue;
      var range = document.createRange();
      range.selectNodeContents(n);
      var rects = range.getClientRects();
      if (!rects || rects.length === 0) continue;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var k = 0; k < rects.length; k++) {
        var rr = rects[k];
        if (rr.width === 0 && rr.height === 0) continue;
        minX = Math.min(minX, rr.left); minY = Math.min(minY, rr.top);
        maxX = Math.max(maxX, rr.right); maxY = Math.max(maxY, rr.bottom);
      }
      if (minX === Infinity) continue;
      runs.push({
        text: raw.replace(/\s+/g, ' ').trim(),
        lines: rects.length,
        rect: { x: minX + sx, y: minY + sy, width: maxX - minX, height: maxY - minY },
      });
    }
    return runs;
  }

  function pseudoOf(el, which) {
    if (!INCLUDE_PSEUDO) return null;
    var ps;
    try { ps = window.getComputedStyle(el, which); } catch (e) { return null; }
    if (!ps) return null;
    var content = ps.content;
    if (!content || content === 'none' || content === 'normal') return null;
    var bg = parseColor(ps.backgroundColor);
    var hasBg = (bg && bg.a > 0) || (ps.backgroundImage && ps.backgroundImage !== 'none');
    var txt = content.replace(/^["'](.*)["']$/, '$1');
    var isTextual = txt && txt !== 'none' && content.indexOf('url(') !== 0;
    if (!hasBg && !isTextual) return null;
    return {
      which: which,
      content: isTextual ? txt : null,
      width: parseFloat(ps.width) || 0,
      height: parseFloat(ps.height) || 0,
      backgroundColor: bg && bg.a > 0 ? { color: bg, hex: hex(bg) } : null,
      font: isTextual ? readFont(ps) : null,
    };
  }

  // ----------------------------------------------------------- text blocks
  // A paragraph is ONE text layer, not one layer per <span>. Sites that split
  // text for animation (SplitType, GSAP, Webflow, Framer) otherwise explode
  // into hundreds of single-character nodes.
  var INLINE_DISPLAY = { inline: 1, 'inline-block': 1, 'inline-flex': 1, contents: 1, ruby: 1, 'ruby-text': 1, 'inline-grid': 1 };
  var TEXT_BLOCK_MAX_DESCENDANTS = 300;
  var TEXT_BLOCK_MAX_CHARS = 6000;
  var NON_TEXT_SELECTOR = 'img,svg,video,canvas,iframe,input,textarea,select,picture,object,embed,hr,table,ul,ol';

  function isTextBlock(el) {
    var txt = el.textContent;
    if (!txt || !txt.trim()) return false;
    if (txt.length > TEXT_BLOCK_MAX_CHARS) return false;
    if (el.querySelector(NON_TEXT_SELECTOR)) return false;
    var kids = el.querySelectorAll('*');
    if (kids.length > TEXT_BLOCK_MAX_DESCENDANTS) return false;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.tagName === 'BR' || k.tagName === 'WBR') continue;
      var ks;
      try { ks = window.getComputedStyle(k); } catch (e) { return false; }
      if (!ks) return false;
      if (ks.display === 'none') continue;
      if (!INLINE_DISPLAY[ks.display]) return false;          // a block child means separate layers
      if (ks.position === 'absolute' || ks.position === 'fixed') return false;
      var kbg = parseColor(ks.backgroundColor);
      if (kbg && kbg.a > 0.02) return false;                  // a highlighted/pill child paints
      if (ks.backgroundImage && ks.backgroundImage !== 'none') return false;
      if (readBorders(ks)) return false;
      if (ks.boxShadow && ks.boxShadow !== 'none') return false;
      var tf = ks.transform;
      if (tf && tf !== 'none' && tf !== 'matrix(1, 0, 0, 1, 0, 0)') return false; // individually transformed
    }
    return true;
  }

  /** False when the element or any ancestor is display:none, visibility:hidden,
   *  or opacity:0 — the usual way sites hide stacked/alternate content. */
  function isRenderable(el, stopAt) {
    if (!el || el.nodeType !== 1) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
      } catch (e) { /* older engines ignore the options bag */ }
    }
    var cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 48) {
      var st;
      try { st = window.getComputedStyle(cur); } catch (e) { return true; }
      if (!st) return true;
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
      var o = parseFloat(st.opacity);
      if (!isNaN(o) && o <= 0.01) return false;
      if (cur === stopAt) break;
      cur = cur.parentElement;
    }
    return true;
  }

  /** Flatten to a single string, recording which element produced each range. */
  function buildTextContent(el) {
    var chars = '';
    var owners = [];
    (function rec(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.nodeType === 3) {
          var t = c.nodeValue.replace(/\s+/g, ' ');
          if (!t) continue;
          if (!isRenderable(c.parentElement || el, el)) continue;
          if (t === ' ' && (chars === '' || /[\s\n]$/.test(chars))) continue;
          if (/^\s/.test(t) && /[\s\n]$/.test(chars)) t = t.replace(/^\s+/, '');
          if (!t) continue;
          var start = chars.length;
          chars += t;
          owners.push({ start: start, end: chars.length, el: c.parentElement || el });
        } else if (c.nodeType === 1) {
          if (c.tagName === 'BR') { chars = chars.replace(/[ \t]+$/, '') + '\n'; continue; }
          var cs;
          try { cs = window.getComputedStyle(c); } catch (e) { continue; }
          if (cs && cs.display === 'none') continue;
          if (!isRenderable(c, el)) continue;
          rec(c);
        }
      }
    })(el);

    chars = chars.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
    var lead = chars.length - chars.replace(/^\s+/, '').length;
    chars = chars.trim();
    if (lead) {
      owners = owners.map(function (o) { return { start: Math.max(0, o.start - lead), end: Math.max(0, o.end - lead), el: o.el }; });
    }
    owners = owners.filter(function (o) { return o.end > o.start && o.start < chars.length; })
                   .map(function (o) { return { start: o.start, end: Math.min(o.end, chars.length), el: o.el }; });
    return { characters: chars, owners: owners };
  }

  function fontSignature(f) {
    return [f.family, f.weight, f.style, f.size, f.colorHex, f.decoration, f.letterSpacing ? f.letterSpacing.value : 0].join('|');
  }

  /** Per-range overrides vs. the block's base font — drives setRange* in Figma. */
  function styleRunsFor(owners, baseFont, rootEl) {
    var runs = [];
    for (var i = 0; i < owners.length; i++) {
      var o = owners[i];
      if (o.el === rootEl) continue;
      var st;
      try { st = window.getComputedStyle(o.el); } catch (e) { continue; }
      if (!st) continue;
      var f = readFont(st);
      var link = o.el.closest ? o.el.closest('a[href]') : null;
      var href = link ? absUrl(link.getAttribute('href')) : null;
      if (fontSignature(f) === fontSignature(baseFont) && !href) continue;
      var run = { start: o.start, end: o.end };
      if (f.family !== baseFont.family) run.family = f.family;
      if (f.weight !== baseFont.weight) run.weight = f.weight;
      if (f.style !== baseFont.style) run.fontStyle = f.style;
      if (f.size !== baseFont.size) run.size = f.size;
      if (f.colorHex !== baseFont.colorHex) { run.color = f.color; run.colorHex = f.colorHex; }
      if (f.decoration !== baseFont.decoration) run.decoration = f.decoration;
      if (href) run.href = href;
      runs.push(run);
    }
    // Merge adjacent runs carrying identical overrides.
    var merged = [];
    for (var j = 0; j < runs.length; j++) {
      var prev = merged[merged.length - 1];
      var cur = runs[j];
      if (prev && prev.end === cur.start) {
        var a = Object.assign({}, prev); delete a.start; delete a.end;
        var b = Object.assign({}, cur); delete b.start; delete b.end;
        if (JSON.stringify(a) === JSON.stringify(b)) { prev.end = cur.end; continue; }
      }
      merged.push(cur);
    }
    return merged;
  }

  function contentBox(rect, style) {
    var bl = parseFloat(style.borderLeftWidth) || 0, br2 = parseFloat(style.borderRightWidth) || 0;
    var bt = parseFloat(style.borderTopWidth) || 0, bb = parseFloat(style.borderBottomWidth) || 0;
    var pl = parseFloat(style.paddingLeft) || 0, pr = parseFloat(style.paddingRight) || 0;
    var pt = parseFloat(style.paddingTop) || 0, pb = parseFloat(style.paddingBottom) || 0;
    return {
      x: rect.x + bl + pl,
      y: rect.y + bt + pt,
      width: Math.max(0, rect.width - bl - br2 - pl - pr),
      height: Math.max(0, rect.height - bt - bb - pt - pb),
    };
  }

  function inkRect(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var rects = range.getClientRects();
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var tops = {};
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width === 0 && r.height === 0) continue;
        minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
        // Inline children split a line into several rects; the distinct tops
        // are the real line count, which decides whether text may wrap.
        tops[Math.round(r.top)] = 1;
      }
      if (minX === Infinity) return null;
      return {
        x: minX + sx, y: minY + sy, width: maxX - minX, height: maxY - minY,
        lines: Math.max(1, Object.keys(tops).length),
      };
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------- transforms
  // A rotated element's getBoundingClientRect() is the AABB of the *rotated*
  // box, not its layout box. A pure rotation preserves the centre, so the
  // unrotated box is the layout size centred on that same point.
  /** Linear part [a,b,c,d] of the element's own 2D transform, or null. */
  function decodeMatrix(style) {
    var tf = style.transform;
    if (!tf || tf === 'none') return null;
    var m = tf.match(/^matrix\(([^)]+)\)$/);
    if (m) {
      var p = m[1].split(',').map(parseFloat);
      return [p[0], p[1], p[2], p[3]];
    }
    var m3 = tf.match(/^matrix3d\(([^)]+)\)$/);
    if (m3) {
      var q = m3[1].split(',').map(parseFloat);
      return [q[0], q[1], q[4], q[5]];
    }
    return null;
  }

  function decodeRotation(style) {
    var tf = style.transform;
    if (!tf || tf === 'none') return 0;
    var m = tf.match(/^matrix\(([^)]+)\)$/);
    if (!m) {
      var m3 = tf.match(/^matrix3d\(([^)]+)\)$/);
      if (!m3) return 0;
      var q = m3[1].split(',').map(parseFloat);
      return Math.atan2(q[1], q[0]) * 180 / Math.PI;
    }
    var p = m[1].split(',').map(parseFloat);
    return Math.atan2(p[1], p[0]) * 180 / Math.PI;
  }

  /** Rotate a point about a centre by -deg (used to undo an ancestor's spin). */
  function unrotatePoint(px, py, cx, cy, deg) {
    var r = -deg * Math.PI / 180;
    var cos = Math.cos(r), sin = Math.sin(r);
    var dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1, BR: 1, WBR: 1 };
  var REPLACED = { IMG: 1, SVG: 1, VIDEO: 1, CANVAS: 1, PICTURE: 1, IFRAME: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1 };

  function walk(el, depth, frame) {
    if (nodeCount >= MAX_NODES) { truncated = true; return null; }
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName;
    if (SKIP_TAGS[tag]) return null;

    var style;
    try { style = window.getComputedStyle(el); } catch (e) { return null; }
    if (!style) return null;
    if (style.display === 'none') return null;

    var rect = absRect(el);
    var ownMatrix = decodeMatrix(style);
    var ownRot = decodeRotation(style);
    // A mirrored transform (negative determinant) is not a rotation; its angle
    // is meaningless on its own, so the matrix travels with the node instead.
    var mirrored = !!ownMatrix && (ownMatrix[0] * ownMatrix[3] - ownMatrix[1] * ownMatrix[2]) < 0;
    if (mirrored) ownRot = 0;

    // Replace the rotated AABB with the real layout box, centred identically.
    if (Math.abs(ownRot) > 0.01 && el.offsetWidth && el.offsetHeight) {
      var ccx = rect.x + rect.width / 2, ccy = rect.y + rect.height / 2;
      rect = { x: ccx - el.offsetWidth / 2, y: ccy - el.offsetHeight / 2, width: el.offsetWidth, height: el.offsetHeight };
    }
    // Page-space centre, before rebasing — rotation preserves it.
    var pageCx = rect.x + rect.width / 2, pageCy = rect.y + rect.height / 2;
    // Inside a rotated ancestor, express this box in that ancestor's unrotated frame.
    if (frame) {
      var u = unrotatePoint(pageCx, pageCy, frame.cx, frame.cy, frame.deg);
      rect = { x: u.x - rect.width / 2, y: u.y - rect.height / 2, width: rect.width, height: rect.height };
    }
    // Figma nests, so a child already inherits its parent's spin: what it needs
    // is its OWN rotation relative to that parent, which is exactly ownRot.
    var netRot = ownRot;
    var hidden = style.visibility === 'hidden' || style.visibility === 'collapse';
    var opacity = parseFloat(style.opacity);
    if (isNaN(opacity)) opacity = 1;

    var invisible = opacity <= 0.01;
    var tooSmall = rect.width < MIN_SIZE && rect.height < MIN_SIZE;
    var clipped = style.clip === 'rect(0px, 0px, 0px, 0px)' || (style.position === 'absolute' && rect.width <= 1 && rect.height <= 1);

    var bg = parseColor(style.backgroundColor);
    var bgLayers = bgImageLayers(style, rect.width, rect.height);
    var borders = readBorders(style);
    var radius = readRadius(style, rect.width, rect.height);
    var shadows = readShadows(style);
    var isReplaced = !!REPLACED[tag];

    var paints = !!(bg && bg.a > 0) || bgLayers.length > 0 || !!borders || !!shadows;
    var runs = textRunsOf(el, style);
    var before = pseudoOf(el, '::before');
    var after = pseudoOf(el, '::after');

    var node = {
      id: 'n' + ++nodeCount,
      tag: tag.toLowerCase(),
      name: nameFor(el, style),
      path: cssPath(el),
      rect: rect,
      depth: depth,
      opacity: opacity,
      hidden: hidden || tooSmall || clipped || invisible,
      position: style.position,
      zIndex: style.zIndex === 'auto' ? null : parseInt(style.zIndex, 10),
      overflow: style.overflow,
      clipsContent: style.overflow === 'hidden' || style.overflow === 'clip' || style.overflowY === 'hidden',
      paints: paints,
      rotation: Math.abs(netRot) > 0.01 ? Math.round(netRot * 100) / 100 : 0,
      matrix: ownMatrix && (mirrored || Math.abs(netRot) > 0.01)
        ? ownMatrix.map(function (v) { return Math.round(v * 10000) / 10000; }) : null,
      children: [],
    };

    if (bg && bg.a > 0) node.fill = { type: 'SOLID', color: bg, hex: hex(bg), opacity: bg.a };
    if (bgLayers.length) node.backgroundLayers = bgLayers;
    if (borders) node.border = borders;
    if (radius) node.radius = radius;
    if (shadows) node.effects = shadows;
    if (before) node.before = before;
    if (after) node.after = after;

    var al = readAutoLayout(style);
    if (al) node.autoLayout = al;
    else {
      var pt = parseFloat(style.paddingTop) || 0, pr = parseFloat(style.paddingRight) || 0;
      var pb = parseFloat(style.paddingBottom) || 0, pl = parseFloat(style.paddingLeft) || 0;
      if (pt || pr || pb || pl) node.padding = { top: pt, right: pr, bottom: pb, left: pl };
    }

    // Replaced content -> assets
    if (tag === 'IMG') {
      var src = el.currentSrc || el.src;
      var url = absUrl(src);
      node.type = 'IMAGE';
      node.image = {
        assetId: url ? addAsset({ kind: 'image', url: url, source: 'img', alt: el.alt || null, naturalWidth: el.naturalWidth || null, naturalHeight: el.naturalHeight || null }) : null,
        url: url, alt: el.alt || null,
        naturalWidth: el.naturalWidth || null, naturalHeight: el.naturalHeight || null,
        objectFit: style.objectFit || 'fill',
      };
      if (el.alt) node.name = el.alt.slice(0, 40);
      return node;
    }
    if (tag === 'SVG' || tag === 'svg') {
      node.type = 'VECTOR';
      var markup = '';
      try { markup = new XMLSerializer().serializeToString(el); } catch (e) { markup = el.outerHTML || ''; }
      if (markup.length > 120000) { markup = ''; warnings.push('SVG too large to inline at ' + node.path); }
      node.svg = { assetId: addAsset({ kind: 'svg', svg: markup, width: rect.width, height: rect.height, path: node.path }), width: rect.width, height: rect.height };
      return node;
    }
    if (tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IFRAME') {
      node.type = 'PLACEHOLDER';
      node.placeholderKind = tag.toLowerCase();
      if (tag === 'VIDEO') node.poster = absUrl(el.poster || '');
      return node;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      node.type = 'INPUT';
      node.input = {
        inputType: el.type || tag.toLowerCase(),
        placeholder: el.placeholder || null,
        value: el.value || null,
        font: readFont(style),
      };
      return node;
    }

    // Whole-paragraph coalescing: a pure-inline block becomes ONE text layer.
    if (isTextBlock(el)) {
      var built = buildTextContent(el);
      if (built.characters) {
        var baseFont = readFont(style);
        var cbox = contentBox(rect, style);
        var ink = inkRect(el);
        var textNode = {
          id: 'n' + ++nodeCount,
          type: 'TEXT',
          tag: node.tag,
          name: built.characters.slice(0, 40).replace(/\n/g, ' '),
          path: node.path,
          rect: (cbox.width >= 1 && cbox.height >= 1) ? cbox : (ink || rect),
          inkRect: ink,
          lines: ink && ink.lines ? ink.lines : 1,
          boxRect: rect,
          depth: depth,
          opacity: opacity,
          hidden: node.hidden,
          characters: built.characters,
          font: baseFont,
          styleRuns: styleRunsFor(built.owners, baseFont, el),
          children: [],
        };
        textNode.rotation = node.rotation;
        textNode.matrix = node.matrix;
        if (el.tagName === 'A' && el.getAttribute('href')) textNode.href = absUrl(el.getAttribute('href'));
        if (before && before.content) textNode.before = before;
        if (after && after.content) textNode.after = after;

        if (paints || node.autoLayout || node.padding) {
          node.children.push(textNode);   // painted/structured container keeps its frame
          node.type = 'FRAME';
          return node;
        }
        textNode.collapsedFrom = [node.name];
        return textNode;                   // bare text needs no wrapper
      }
    }

    // Text runs become dedicated children so each gets real geometry
    if (runs.length) {
      node.font = readFont(style);
      for (var i = 0; i < runs.length; i++) {
        if (nodeCount >= MAX_NODES) { truncated = true; break; }
        var r = runs[i];
        node.children.push({
          id: 'n' + ++nodeCount,
          type: 'TEXT',
          tag: '#text',
          name: r.text.slice(0, 40) || 'Text',
          path: node.path + ' > #text',
          rect: r.rect,
          depth: depth + 1,
          opacity: 1,
          hidden: false,
          characters: r.text,
          lines: r.lines,
          font: node.font,
          children: [],
        });
      }
    }

    // Once a node carries the rotation, its subtree inherits it through nesting,
    // so descendants are measured in this node's unrotated frame.
    var childFrame = frame;
    if (Math.abs(ownRot) > 0.01) {
      childFrame = { cx: pageCx, cy: pageCy, deg: (frame ? frame.deg : 0) + ownRot };
    }

    if (depth < MAX_DEPTH) {
      for (var c = 0; c < el.children.length; c++) {
        var child = walk(el.children[c], depth + 1, childFrame);
        if (child) node.children.push(child);
      }
    } else if (el.children.length) {
      truncated = true;
    }

    // Keep DOM paint order: children sorted by document order already; stable.
    if (!node.type) node.type = node.children.length ? 'FRAME' : (isReplaced ? 'PLACEHOLDER' : 'RECT');
    return node;
  }

  // Collapse non-painting single-child wrappers whose box matches their child.
  function collapse(node) {
    if (!node) return node;
    node.children = node.children.map(collapse).filter(Boolean);
    if (!PRUNE) return node;
    while (
      node.children.length === 1 &&
      node.type === 'FRAME' &&
      !node.paints && !node.autoLayout && !node.padding && !node.before && !node.after &&
      node.opacity === 1 && !node.clipsContent
    ) {
      var c = node.children[0];
      var sameBox =
        Math.abs(c.rect.x - node.rect.x) < 1.5 && Math.abs(c.rect.y - node.rect.y) < 1.5 &&
        Math.abs(c.rect.width - node.rect.width) < 1.5 && Math.abs(c.rect.height - node.rect.height) < 1.5;
      if (!sameBox) break;
      c.collapsedFrom = (node.collapsedFrom || []).concat([node.name]);
      node = c;
    }
    return node;
  }

  // Drop subtrees that render nothing at all.
  function prune(node) {
    if (!node) return null;
    node.children = node.children.map(prune).filter(Boolean);
    if (node.type === 'TEXT' || node.type === 'IMAGE' || node.type === 'VECTOR' || node.type === 'INPUT' || node.type === 'PLACEHOLDER') {
      if (node.hidden && !KEEP_HIDDEN) return null;
      if (node.type === 'TEXT' && !String(node.characters || '').trim()) return null;
      return node;
    }
    if (node.hidden && node.children.length === 0) return null;
    if (!node.paints && node.children.length === 0) return null;
    if (node.rect.width < MIN_SIZE && node.rect.height < MIN_SIZE && node.children.length === 0) return null;
    return node;
  }

  var root = walk(document.body, 0, null);
  if (root) { root = collapse(root); if (PRUNE) root = prune(root); }

  // Count what actually survived pruning — the walked total is just the budget.
  var emittedCount = 0;
  var emittedByType = Object.create(null);
  (function tally(n) {
    if (!n) return;
    emittedCount++;
    emittedByType[n.type] = (emittedByType[n.type] || 0) + 1;
    for (var i = 0; i < n.children.length; i++) tally(n.children[i]);
  })(root);

  // Page-level background: html/body cascade decides the canvas colour.
  var bodyStyle = window.getComputedStyle(document.body);
  var htmlStyle = window.getComputedStyle(docEl);
  var pageBg = parseColor(bodyStyle.backgroundColor);
  if (!pageBg || pageBg.a === 0) pageBg = parseColor(htmlStyle.backgroundColor);
  if (!pageBg || pageBg.a === 0) pageBg = { r: 1, g: 1, b: 1, a: 1 };

  // Fonts actually in use, for mapping onto Figma families later.
  var fontUse = Object.create(null);
  (function collectFonts(n) {
    if (!n) return;
    if (n.font && n.font.family) {
      var k = n.font.family + '|' + n.font.weight + '|' + (n.font.italic ? 'italic' : 'normal');
      fontUse[k] = (fontUse[k] || 0) + 1;
    }
    for (var i = 0; i < n.children.length; i++) collectFonts(n.children[i]);
  })(root);

  return {
    meta: {
      url: location.href,
      title: document.title,
      lang: docEl.lang || null,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      page: { width: pageWidth, height: pageHeight },
      background: { color: pageBg, hex: hex(pageBg) },
      extractedAt: new Date().toISOString(),
    },
    fonts: Object.keys(fontUse).map(function (k) {
      var p = k.split('|');
      return { family: p[0], weight: parseInt(p[1], 10), italic: p[2] === 'italic', count: fontUse[k] };
    }).sort(function (a, b) { return b.count - a.count; }),
    tree: root,
    assets: assets,
    stats: { nodeCount: emittedCount, walked: nodeCount, truncated: truncated, maxNodes: MAX_NODES, byType: emittedByType },
    warnings: warnings,
  };
})
