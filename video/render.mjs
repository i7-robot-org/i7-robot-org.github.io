#!/usr/bin/env node
// Renders ../film.html frame by frame (window.render(t)) into an MP4, or a single PNG still.
//
//   node render.mjs --still 32.5 --out still.png [--clean] [--size 1920x1080]   (--still 8,16,24 --out qa_%t.png for several)
//   node render.mjs --still 0 --query studio=-0.65 --out portrait.png --size 1200x1200   (robot alone on white)
//   node render.mjs --out i7_demo.mp4 [--start 0] [--duration 65.5] [--fps 30] [--workers 4] [--audio mix.wav]
//
// Needs Node 18+, Playwright with Chromium, and ffmpeg on PATH.
// THREE_DIR=/path/to/node_modules/three serves three.js from disk when cdn.jsdelivr.net is unreachable.
// BROWSER_PROXY=http://host:port sends the remaining requests (web fonts) through a proxy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const [W, H] = String(args.size || '1920x1080').split('x').map(Number);
const fps = +(args.fps || 30);
const out = path.resolve(String(args.out || 'out.mp4'));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.css': 'text/css', '.glb': 'model/gltf-binary', '.wav': 'audio/wav' };
function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function openPage(port, clean) {
  const browser = await chromium.launch({
    args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl'],
    ...(process.env.BROWSER_PROXY ? { proxy: { server: process.env.BROWSER_PROXY, bypass: '127.0.0.1' } } : {}),
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('[page]', e.message));
  if (process.env.THREE_DIR) {
    await page.route('https://cdn.jsdelivr.net/npm/three@0.160.0/**', route => {
      const rel = new URL(route.request().url()).pathname.replace('/npm/three@0.160.0/', '');
      route.fulfill({ path: path.join(process.env.THREE_DIR, rel), contentType: 'text/javascript' });
    });
  }
  const query = [clean ? 'clean=1' : '', args.query && args.query !== true ? args.query : ''].filter(Boolean).join('&');
  await page.goto(`http://127.0.0.1:${port}/film.html${query ? `?${query}` : ''}`);
  await page.waitForFunction('window.ready === true', null, { timeout: 180000 });
  return { browser, page };
}

function ffmpegWriter(file, audio, start) {
  const cmd = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
  if (audio) cmd.push('-ss', String(start), '-i', audio);
  cmd.push('-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(args.crf || 20), '-movflags', '+faststart');
  if (audio) cmd.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
  cmd.push(file);
  return spawn('ffmpeg', cmd, { stdio: ['pipe', 'inherit', 'inherit'] });
}

async function renderRange(port, first, count, file, tag) {
  const { browser, page } = await openPage(port, !!args.clean);
  const ff = ffmpegWriter(file);
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const t = (+(args.start || 0)) + (first + i) / fps;
    await page.evaluate(t => window.render(t), t);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i && i % 60 === 0) console.log(`[${tag}] ${i}/${count} frames, ${((Date.now() - t0) / i).toFixed(0)} ms/frame`);
  }
  await browser.close();
  ff.stdin.end();
  await new Promise((r, j) => ff.on('close', c => c === 0 ? r() : j(new Error('ffmpeg failed'))));
}

const server = await serve();
const port = server.address().port;
try {
  if (args.still !== undefined) {
    // --still accepts a comma list; --out may contain %t, replaced by the time
    const { browser, page } = await openPage(port, !!args.clean);
    for (const t of String(args.still).split(',').map(Number)) {
      const file = out.replace('%t', t.toFixed(1).padStart(4, '0'));
      await page.evaluate(t => window.render(t), t);
      await page.screenshot({ path: file, type: file.endsWith('.jpg') ? 'jpeg' : 'png' });
      console.log(`${file}: still at t=${t}s`);
    }
    await browser.close();
  } else {
    const duration = +(args.duration || 65.5);
    const frames = Math.round(duration * fps), workers = Math.max(1, +(args.workers || 1));
    const per = Math.ceil(frames / workers), parts = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: workers }, (_, w) => {
      const first = w * per, count = Math.min(per, frames - first);
      const file = `${out}.part${w}.mp4`; parts.push(file);
      return count > 0 ? renderRange(port, first, count, file, `w${w}`) : null;
    }));
    const list = `${out}.parts.txt`;
    fs.writeFileSync(list, parts.filter(fs.existsSync).map(p => `file '${p}'`).join('\n'));
    const cmd = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
    if (args.audio) cmd.push('-i', path.resolve(String(args.audio)), '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-shortest');
    cmd.push('-c:v', 'copy', '-movflags', '+faststart', out);
    if (spawnSync('ffmpeg', cmd, { stdio: 'inherit' }).status !== 0) throw new Error('concat failed');
    for (const p of [...parts, list]) fs.rmSync(p, { force: true });
    console.log(`${out}: ${frames} frames @ ${fps}fps, ${W}x${H}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  server.close();
}
