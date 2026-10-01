#!/usr/bin/env node
/**
 * figma-forge — push extracted assets into Figma.
 *
 * `upload_assets` hands back N single-use upload URLs; this POSTs the matching
 * local files to them with the right Content-Type, in parallel, and reports
 * exactly which succeeded.
 *
 * Two steps:
 *   1. List what needs uploading (ordered — the order defines nodeIds order):
 *        node scripts/upload-assets.mjs --dir <out-dir> --list
 *   2. After calling upload_assets with that count + nodeIds, POST the bytes:
 *        node scripts/upload-assets.mjs --dir <out-dir> --plan plan.json
 *
 * plan.json is [{ "assetId": "asset-3", "url": "https://..." }, ...]
 *
 * Options:
 *   --dir <dir>       Extraction output directory (holds design-*.json + assets/)
 *   --design <file>   Specific design-*.json (default: first in --dir)
 *   --list            Print the ordered upload manifest and exit
 *   --plan <file>     JSON array pairing assetId -> upload URL
 *   --kind <k>        Filter: image | svg | all (default: image)
 *   --max <n>         Cap the manifest length (upload_assets allows 60 per call)
 *   --skip <n>        Skip the first n assets (for paging past 60)
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const CT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
};
const FIGMA_OK = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

function parseArgs(argv) {
  const o = { kind: 'image' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], take = () => argv[++i];
    if (a === '--dir') o.dir = take();
    else if (a === '--design') o.design = take();
    else if (a === '--list') o.list = true;
    else if (a === '--plan') o.plan = take();
    else if (a === '--kind') o.kind = take();
    else if (a === '--max') o.max = Number(take());
    else if (a === '--skip') o.skip = Number(take());
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

async function loadAssets(args) {
  const dir = resolve(args.dir);
  let designFile = args.design ? resolve(args.design) : null;
  if (!designFile) {
    const entries = await readdir(dir);
    const hit = entries.find((f) => /^design-.*\.json$/.test(f));
    if (!hit) throw new Error(`No design-*.json in ${dir}`);
    designFile = join(dir, hit);
  }
  const data = JSON.parse(await readFile(designFile, 'utf8'));
  const assets = (data.assets || [])
    .filter((a) => a.downloaded && a.file)
    .filter((a) => (args.kind === 'all' ? true : args.kind === 'svg' ? a.kind === 'svg' : a.kind !== 'svg'))
    .map((a) => {
      const path = join(dir, a.file);
      const ct = a.contentType && FIGMA_OK.has(a.contentType) ? a.contentType : (CT[extname(a.file).toLowerCase()] || null);
      return { assetId: a.id, file: a.file, path, contentType: ct, bytes: a.bytes, exists: existsSync(path), url: a.url || null };
    })
    .filter((a) => a.exists && a.contentType && FIGMA_OK.has(a.contentType) && a.bytes <= 10 * 1024 * 1024);
  return { dir, designFile, assets };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }
  if (args.help || !args.dir) {
    const src = await readFile(new URL(import.meta.url), 'utf8');
    console.log(src.split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
    process.exit(args.dir ? 0 : 2);
  }

  const { dir, assets } = await loadAssets(args);
  const sliced = assets.slice(args.skip || 0, (args.skip || 0) + (args.max || 60));

  if (args.list || !args.plan) {
    console.log(JSON.stringify({
      dir,
      total: assets.length,
      returned: sliced.length,
      note: 'Request exactly `returned` upload URLs from upload_assets, with nodeIds in THIS order. Then re-run with --plan.',
      assets: sliced.map((a) => ({ assetId: a.assetId, file: a.file, contentType: a.contentType, bytes: a.bytes })),
    }, null, 2));
    return;
  }

  const plan = JSON.parse(await readFile(resolve(args.plan), 'utf8'));
  const byId = Object.fromEntries(assets.map((a) => [a.assetId, a]));
  const jobs = (Array.isArray(plan) ? plan : plan.uploads || []).map((p, i) => ({
    assetId: p.assetId || sliced[i]?.assetId,
    url: p.url || p.uploadUrl,
  }));

  const results = [];
  const CONC = 6;
  let ix = 0;
  async function worker() {
    while (ix < jobs.length) {
      const j = jobs[ix++];
      const a = byId[j.assetId];
      if (!a) { results.push({ assetId: j.assetId, ok: false, reason: 'asset not found in manifest' }); continue; }
      if (!j.url) { results.push({ assetId: j.assetId, ok: false, reason: 'no upload url' }); continue; }
      try {
        const body = await readFile(a.path);
        const res = await fetch(j.url, {
          method: 'POST',
          headers: { 'content-type': a.contentType, 'content-length': String(body.length) },
          body,
          signal: AbortSignal.timeout(60000),
        });
        const text = await res.text().catch(() => '');
        results.push(res.ok
          ? { assetId: j.assetId, ok: true, bytes: body.length, status: res.status }
          : { assetId: j.assetId, ok: false, status: res.status, reason: text.slice(0, 200) });
      } catch (e) {
        results.push({ assetId: j.assetId, ok: false, reason: String(e.message || e).slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, jobs.length)) }, worker));

  const ok = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ uploaded: ok, failed: results.length - ok, results }, null, 2));
  if (ok < results.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
