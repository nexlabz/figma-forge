#!/usr/bin/env node
/**
 * figma-forge — website -> design-tree extractor.
 *
 * Renders a URL in headless Chrome and writes a Figma-shaped JSON description of
 * the page (geometry, paints, text, auto-layout hints), plus downloaded assets
 * and a reference screenshot.
 *
 * Usage:
 *   node scripts/extract-site.mjs <url|local-html-file> [options]
 *
 * A local .html file (a saved Claude artifact, a build output) is served on an
 * ephemeral loopback port first — file:// would block its scripts and fonts.
 *
 * Options:
 *   --out <dir>          Output directory (default: ./figma-forge-out/<host>)
 *   --viewport <preset>  desktop | tablet | mobile | <W>x<H>   (default: desktop)
 *   --viewports <list>   Comma-separated presets to capture in one run
 *   --max-nodes <n>      Node budget per viewport (default: 4000)
 *   --max-depth <n>      Max DOM depth (default: 32)
 *   --wait <ms>          Extra settle time after network idle (default: 1200)
 *   --timeout <ms>       Navigation timeout (default: 45000)
 *   --no-prune           Keep non-painting wrapper elements
 *   --keep-hidden        Keep nodes hidden via opacity/visibility/clip
 *   --no-assets          Skip downloading images
 *   --no-screenshot      Skip the reference screenshot
 *   --no-scroll          Skip the lazy-load autoscroll pass
 *   --headful            Run with a visible browser window
 *   --cookie <k=v>       Set a cookie (repeatable)
 *   --header <k:v>       Extra HTTP header (repeatable)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, CDPConnection, newPageSession } from './lib/cdp.mjs';
import { serveLocalFile } from './lib/serve.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESETS = {
  desktop: { width: 1440, height: 900, mobile: false, dsf: 1 },
  'desktop-lg': { width: 1920, height: 1080, mobile: false, dsf: 1 },
  laptop: { width: 1280, height: 800, mobile: false, dsf: 1 },
  tablet: { width: 834, height: 1112, mobile: true, dsf: 2 },
  mobile: { width: 390, height: 844, mobile: true, dsf: 3 },
};
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function parseArgs(argv) {
  const out = { cookies: [], headers: {}, viewports: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '--out': out.out = take(); break;
      case '--viewport': out.viewports.push(take()); break;
      case '--viewports': out.viewports.push(...take().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--max-nodes': out.maxNodes = parseInt(take(), 10); break;
      case '--max-depth': out.maxDepth = parseInt(take(), 10); break;
      case '--wait': out.wait = parseInt(take(), 10); break;
      case '--timeout': out.timeout = parseInt(take(), 10); break;
      case '--no-prune': out.prune = false; break;
      case '--keep-hidden': out.keepHidden = true; break;
      case '--no-assets': out.assets = false; break;
      case '--no-screenshot': out.screenshot = false; break;
      case '--no-scroll': out.scroll = false; break;
      case '--headful': out.headful = true; break;
      case '--cookie': out.cookies.push(take()); break;
      case '--header': { const h = take(); const ix = h.indexOf(':'); if (ix > 0) out.headers[h.slice(0, ix).trim()] = h.slice(ix + 1).trim(); break; }
      case '-h': case '--help': out.help = true; break;
      default: if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`); rest.push(a);
    }
  }
  out.url = rest[0];
  if (!out.viewports.length) out.viewports = ['desktop'];
  return out;
}

function resolveViewport(name) {
  if (PRESETS[name]) return { name, ...PRESETS[name] };
  const m = String(name).match(/^(\d+)x(\d+)$/);
  if (m) return { name, width: +m[1], height: +m[2], mobile: +m[1] < 600, dsf: +m[1] < 600 ? 3 : 1 };
  throw new Error(`Unknown viewport "${name}". Use ${Object.keys(PRESETS).join(', ')} or WxH.`);
}

/** Wait until no request has been in flight for `quietMs`, or until `maxMs`. */
async function waitForNetworkIdle(conn, sessionId, { quietMs = 600, maxMs = 15000 } = {}) {
  let inflight = 0;
  let lastChange = Date.now();
  const bump = (d) => { inflight = Math.max(0, inflight + d); lastChange = Date.now(); };
  const offs = [
    conn.on('Network.requestWillBeSent', (_p, sid) => { if (sid === sessionId) bump(1); }),
    conn.on('Network.loadingFinished', (_p, sid) => { if (sid === sessionId) bump(-1); }),
    conn.on('Network.loadingFailed', (_p, sid) => { if (sid === sessionId) bump(-1); }),
  ];
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline) {
      if (inflight === 0 && Date.now() - lastChange > quietMs) return true;
      await sleep(100);
    }
    return false;
  } finally { offs.forEach((off) => off()); }
}

async function evaluate(conn, sessionId, expression, { awaitPromise = false, returnByValue = true } = {}) {
  const res = await conn.send('Runtime.evaluate', {
    expression, returnByValue, awaitPromise, allowUnsafeEvalBlockedByCSP: true, timeout: 60000,
  }, sessionId);
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error(`In-page evaluation failed: ${e.exception?.description || e.text || 'unknown'}`);
  }
  return res.result?.value;
}

/** Scroll the page end-to-end so lazy images and scroll-triggered content render. */
async function autoScroll(conn, sessionId) {
  await evaluate(conn, sessionId, `
    (async () => {
      const step = Math.max(200, window.innerHeight * 0.8);
      const max = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 90));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 250));
      // Force-resolve native lazy loading for anything still deferred.
      document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; });
      const imgs = Array.from(document.images).filter(i => !i.complete);
      await Promise.race([
        Promise.all(imgs.map(i => new Promise(r => { i.addEventListener('load', r, {once:true}); i.addEventListener('error', r, {once:true}); }))),
        new Promise(r => setTimeout(r, 4000)),
      ]);
      try { await document.fonts.ready; } catch (e) {}
      return true;
    })()
  `, { awaitPromise: true });
}

/** Freeze CSS animations so the capture is deterministic. */
async function freezeMotion(conn, sessionId) {
  await evaluate(conn, sessionId, `
    (() => {
      const s = document.createElement('style');
      s.setAttribute('data-figma-forge', 'freeze');
      s.textContent = '*,*::before,*::after{animation-play-state:paused !important;transition:none !important;caret-color:transparent !important;}';
      document.head.appendChild(s);
      try { document.getAnimations().forEach(a => { try { a.pause(); a.currentTime = a.effect?.getTiming?.()?.duration || 0; } catch(e){} }); } catch(e){}
      return true;
    })()
  `);
}

const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};

async function downloadAssets(assets, outDir, { cookieHeader, userAgent, referer }) {
  const dir = join(outDir, 'assets');
  await mkdir(dir, { recursive: true });
  const results = [];
  const queue = assets.slice();
  const CONCURRENCY = 6;

  async function worker() {
    while (queue.length) {
      const a = queue.shift();
      try {
        if (a.kind === 'svg') {
          if (!a.svg) { results.push({ id: a.id, ok: false, reason: 'svg markup omitted (too large)' }); continue; }
          const file = `${a.id}.svg`;
          await writeFile(join(dir, file), a.svg, 'utf8');
          results.push({ id: a.id, ok: true, file: `assets/${file}`, bytes: Buffer.byteLength(a.svg), contentType: 'image/svg+xml' });
          continue;
        }
        if (!a.url) { results.push({ id: a.id, ok: false, reason: 'no url' }); continue; }

        if (a.url.startsWith('data:')) {
          const m = a.url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
          if (!m) { results.push({ id: a.id, ok: false, reason: 'unparseable data uri' }); continue; }
          const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
          const ext = EXT_BY_TYPE[m[1]] || 'bin';
          const file = `${a.id}.${ext}`;
          await writeFile(join(dir, file), buf);
          results.push({ id: a.id, ok: true, file: `assets/${file}`, bytes: buf.length, contentType: m[1] });
          continue;
        }

        const headers = { 'user-agent': userAgent, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
        if (cookieHeader) headers.cookie = cookieHeader;
        if (referer) headers.referer = referer;
        const res = await fetch(a.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!res.ok) { results.push({ id: a.id, ok: false, reason: `HTTP ${res.status}` }); continue; }
        const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 12 * 1024 * 1024) { results.push({ id: a.id, ok: false, reason: 'larger than 12MB' }); continue; }
        let ext = EXT_BY_TYPE[ct];
        if (!ext) { const um = a.url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i); ext = um ? um[1].toLowerCase() : 'bin'; }
        const file = `${a.id}.${ext}`;
        await writeFile(join(dir, file), buf);
        results.push({ id: a.id, ok: true, file: `assets/${file}`, bytes: buf.length, contentType: ct || null });
      } catch (e) {
        results.push({ id: a.id, ok: false, reason: String(e.message || e).slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, assets.length)) }, worker));
  return results;
}

/**
 * Re-fetch assets from inside the page.
 *
 * The browser already has the origin's network path, cookies and TLS session, so
 * this succeeds in cases where a direct Node fetch cannot reach the host at all
 * (proxies, split DNS, origins that refuse unknown clients). Batched, because
 * every byte comes back base64 over the DevTools socket.
 */
async function refetchInPage(conn, sessionId, assets, outDir) {
  const dir = join(outDir, 'assets');
  await mkdir(dir, { recursive: true });
  const results = [];
  const BATCH = 8;
  const MAX_INLINE = 4 * 1024 * 1024;

  for (let i = 0; i < assets.length; i += BATCH) {
    const batch = assets.slice(i, i + BATCH);
    const urls = batch.map((a) => a.url);
    let got;
    try {
      got = await evaluate(conn, sessionId, `
        (async () => {
          const urls = ${JSON.stringify(urls)};
          const out = {};
          await Promise.all(urls.map(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include', cache: 'force-cache' });
              if (!r.ok) { out[u] = { ok: false, reason: 'HTTP ' + r.status }; return; }
              const b = await r.blob();
              if (b.size > ${MAX_INLINE}) { out[u] = { ok: false, reason: 'too large to inline' }; return; }
              const b64 = await new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload = () => res(String(fr.result).split(',')[1] || '');
                fr.onerror = () => rej(new Error('read failed'));
                fr.readAsDataURL(b);
              });
              out[u] = { ok: true, b64, contentType: b.type || '' };
            } catch (e) { out[u] = { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; }
          }));
          return out;
        })()
      `, { awaitPromise: true });
    } catch (e) {
      for (const a of batch) results.push({ id: a.id, ok: false, reason: `in-page fetch failed: ${String(e.message).slice(0, 120)}` });
      continue;
    }

    for (const a of batch) {
      const r = got?.[a.url];
      if (!r || !r.ok) { results.push({ id: a.id, ok: false, reason: r?.reason || 'no response' }); continue; }
      try {
        const buf = Buffer.from(r.b64, 'base64');
        let ext = EXT_BY_TYPE[(r.contentType || '').split(';')[0].trim()];
        if (!ext) { const um = a.url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i); ext = um ? um[1].toLowerCase() : 'bin'; }
        const file = `${a.id}.${ext}`;
        await writeFile(join(dir, file), buf);
        results.push({ id: a.id, ok: true, file: `assets/${file}`, bytes: buf.length, contentType: (r.contentType || '').split(';')[0] || null, viaBrowser: true });
      } catch (e) {
        results.push({ id: a.id, ok: false, reason: String(e.message).slice(0, 120) });
      }
    }
  }
  return results;
}

async function captureViewport(conn, sessionId, extractorSrc, url, vp, args, outDir) {
  const label = vp.name;
  process.stderr.write(`  · ${label} (${vp.width}x${vp.height}) … `);

  await conn.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf, mobile: vp.mobile,
    screenWidth: vp.width, screenHeight: vp.height,
  }, sessionId);
  await conn.send('Network.setUserAgentOverride', {
    userAgent: vp.mobile ? MOBILE_UA : (args.userAgent || await evaluate(conn, sessionId, 'navigator.userAgent')),
  }, sessionId).catch(() => {});

  const navDone = conn.once('Page.loadEventFired', { timeoutMs: args.timeout ?? 45000, predicate: (_p, sid) => sid === sessionId }).catch(() => null);
  await conn.send('Page.navigate', { url }, sessionId);
  await navDone;
  await waitForNetworkIdle(conn, sessionId, { maxMs: Math.min(args.timeout ?? 45000, 20000) });
  if (args.scroll !== false) await autoScroll(conn, sessionId).catch(() => {});
  await freezeMotion(conn, sessionId).catch(() => {});
  await sleep(args.wait ?? 1200);

  const opts = {
    maxNodes: args.maxNodes ?? 4000,
    maxDepth: args.maxDepth ?? 32,
    prune: args.prune !== false,
    keepHidden: args.keepHidden === true,
    includePseudo: true,
  };
  const data = await evaluate(conn, sessionId, `(${extractorSrc})(${JSON.stringify(opts)})`);
  if (!data) throw new Error('Extractor returned nothing — the page may have blocked script evaluation.');
  data.meta.viewportPreset = label;

  // Reference screenshot — invaluable for visually checking the Figma rebuild.
  if (args.screenshot !== false) {
    try {
      const h = Math.min(data.meta.page.height, 16000);
      const shot = await conn.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, optimizeForSpeed: false,
        clip: { x: 0, y: 0, width: data.meta.page.width, height: h, scale: 1 },
      }, sessionId);
      await writeFile(join(outDir, `screenshot-${label}.png`), Buffer.from(shot.data, 'base64'));
      data.meta.screenshot = `screenshot-${label}.png`;
    } catch (e) {
      data.warnings.push(`screenshot failed: ${e.message}`);
    }
  }

  // Assets, fetched with the page's own cookies so gated images still resolve.
  if (args.assets !== false && data.assets.length) {
    let cookieHeader = '';
    try {
      const { cookies } = await conn.send('Network.getCookies', { urls: [url] }, sessionId);
      cookieHeader = (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { /* cookies are optional */ }
    const ua = await evaluate(conn, sessionId, 'navigator.userAgent').catch(() => 'Mozilla/5.0');
    const dl = await downloadAssets(data.assets, outDir, { cookieHeader, userAgent: ua, referer: url });
    const byId = Object.fromEntries(dl.map((d) => [d.id, d]));

    // Anything Node could not reach, ask the browser for — it is already on the
    // origin's network with its cookies, so this recovers host-level failures.
    const retry = data.assets.filter((a) => a.url && !a.url.startsWith('data:') && !byId[a.id]?.ok);
    if (retry.length) {
      const second = await refetchInPage(conn, sessionId, retry, outDir);
      let recovered = 0;
      for (const r of second) if (r.ok) { byId[r.id] = r; recovered++; }
      if (recovered) process.stderr.write(`(${recovered}/${retry.length} via browser) `);
    }
    data.assets = data.assets.map((a) => {
      const d = byId[a.id] || {};
      const { svg, ...restOfAsset } = a; // markup now lives on disk
      return { ...restOfAsset, file: d.file || null, bytes: d.bytes ?? null, downloaded: !!d.ok, error: d.ok ? null : d.reason || null };
    });
  }

  process.stderr.write(`${data.stats.nodeCount} nodes, ${data.assets.length} assets${data.stats.truncated ? ' (truncated)' : ''}\n`);
  return data;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (args.help || !args.url) {
    console.log(await readFile(new URL(import.meta.url), 'utf8').then((s) => s.split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, '')));
    process.exit(args.url ? 0 : 2);
  }

  let url = args.url;
  let served = null;
  let label = null;
  if (!/^https?:\/\//i.test(url)) {
    // A path on disk? Serve it; otherwise treat it as a bare hostname.
    const asPath = resolve(url.replace(/^file:\/\//, ''));
    if (existsSync(asPath)) {
      served = await serveLocalFile(asPath);
      label = basename(asPath).replace(/\.html?$/i, '');
      url = served.url;
      process.stderr.write(`figma-forge: serving ${asPath} at ${url}\n`);
    } else {
      url = 'https://' + url;
    }
  }
  let host;
  try { host = label || new URL(url).hostname.replace(/^www\./, ''); }
  catch { console.error(`Not a valid URL or file: ${args.url}`); process.exit(2); }

  const outDir = resolve(args.out || join(process.cwd(), 'figma-forge-out', host));
  await mkdir(outDir, { recursive: true });

  const extractorSrc = await readFile(join(__dirname, 'lib', 'extract-dom.js'), 'utf8');
  const viewports = args.viewports.map(resolveViewport);

  process.stderr.write(`figma-forge: extracting ${url}\n`);
  const { browserWsUrl, kill, binary } = await launchChrome({ headless: !args.headful });
  process.stderr.write(`  browser: ${binary}\n`);
  const conn = await CDPConnection.connect(browserWsUrl);
  const captures = [];
  let failure = null;

  try {
    const { sessionId } = await newPageSession(conn);
    await conn.send('Page.enable', {}, sessionId);
    await conn.send('Network.enable', {}, sessionId);
    await conn.send('Runtime.enable', {}, sessionId);
    await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    if (Object.keys(args.headers).length) {
      await conn.send('Network.setExtraHTTPHeaders', { headers: args.headers }, sessionId);
    }
    if (args.cookies.length) {
      const { hostname } = new URL(url);
      await conn.send('Network.setCookies', {
        cookies: args.cookies.map((c) => {
          const ix = c.indexOf('=');
          return { name: c.slice(0, ix), value: c.slice(ix + 1), domain: hostname, path: '/' };
        }),
      }, sessionId);
    }

    for (const vp of viewports) {
      const data = await captureViewport(conn, sessionId, extractorSrc, url, vp, args, outDir);
      const file = `design-${vp.name}.json`;
      await writeFile(join(outDir, file), JSON.stringify(data, null, 2), 'utf8');
      captures.push({ viewport: vp.name, width: vp.width, height: vp.height, file, nodes: data.stats.nodeCount, truncated: data.stats.truncated, assets: data.assets.length, screenshot: data.meta.screenshot || null, title: data.meta.title, pageHeight: data.meta.page.height });
    }
  } catch (e) {
    failure = e;
  } finally {
    conn.close();
    await kill();
    if (served) await served.close();
  }

  if (failure) { console.error(`\nExtraction failed: ${failure.message}`); process.exit(1); }

  const index = { url, host, extractedAt: new Date().toISOString(), outDir, captures };
  await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  process.stderr.write(`\nWrote ${captures.length} capture(s) to ${outDir}\n`);
  console.log(JSON.stringify(index, null, 2));
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
