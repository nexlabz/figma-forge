/**
 * Minimal Chrome DevTools Protocol client — zero npm dependencies.
 * Relies on Node's built-in global WebSocket (Node >= 22) and fetch.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function resolveChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/')) {
      if (existsSync(c)) return c;
    } else {
      // Bare name — let spawn resolve it via PATH; verified by the launch probe.
      return c;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch headless Chrome and return { browserWsUrl, kill }. */
export async function launchChrome({ headless = true, timeoutMs = 30000 } = {}) {
  const bin = resolveChrome();
  if (!bin) throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH to your browser executable.');

  const userDataDir = await mkdtemp(join(tmpdir(), 'figma-forge-chrome-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-dev-shm-usage',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--no-sandbox',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  proc.on('error', (e) => { stderr += `\nspawn error: ${e.message}`; });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let browserWsUrl = null;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      await rm(userDataDir, { recursive: true, force: true });
      throw new Error(`Chrome exited (code ${proc.exitCode}) before devtools came up.\n${stderr}`);
    }
    if (existsSync(portFile)) {
      try {
        const txt = await readFile(portFile, 'utf8');
        const [port, path] = txt.split('\n');
        if (port && path) { browserWsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`; break; }
      } catch { /* file still being written */ }
    }
    await sleep(80);
  }

  if (!browserWsUrl) {
    proc.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
    throw new Error(`Timed out waiting for Chrome devtools endpoint.\n${stderr}`);
  }

  const kill = async () => {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };
  return { browserWsUrl, kill, binary: bin };
}

/** Flat-protocol CDP connection. One socket, many sessions. */
export class CDPConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) { try { cb(msg.params, msg.sessionId); } catch { /* listener threw */ } }
        for (const cb of this.listeners.get('*') || []) { try { cb(msg); } catch { /* listener threw */ } }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 15000) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`WebSocket error connecting to ${wsUrl}`)); }, { once: true });
    });
    return new CDPConnection(ws);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Resolve on the next matching event, or reject on timeout. */
  once(method, { timeoutMs = 30000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, (params, sessionId) => {
        if (predicate && !predicate(params, sessionId)) return;
        clearTimeout(timer); off(); resolve(params);
      });
    });
  }

  close() { this.closed = true; try { this.ws.close(); } catch { /* already closed */ } }
}

/** Create a page target and attach to it. Returns the flat-protocol sessionId. */
export async function newPageSession(conn, url = 'about:blank') {
  const { targetId } = await conn.send('Target.createTarget', { url });
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}
