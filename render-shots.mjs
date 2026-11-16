// Render the entry's screenshots with real Chrome: each shot mode sets up an honest game state,
// steps the simulation, freezes, then this script captures 1280x720. It waits for the page's own
// window.__shotReady flag rather than sleeping a guessed number of milliseconds, so a slow module
// load cannot produce a half-drawn frame.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = process.argv.slice(2);
const shots = MODES.length ? MODES : ['start', 'buy', 'live', 'fight', 'plant', 'over'];
const PORT = 8099;
const W = 1280;
const H = 720;
const OUT = new URL('./screenshots/', import.meta.url).pathname;

mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ||
  ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find((p) => {
    try {
      return require('node:fs').existsSync(p);
    } catch {
      return false;
    }
  }) ||
  '/usr/bin/google-chrome';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function capture(mode, index) {
  const port = 9300 + index;
  const profile = `/tmp/chrome-shot-${index}`;
  const url = `http://127.0.0.1:${PORT}/?shot=${mode}&seed=1`;

  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      '--window-size=' + W + ',' + H,
      '--hide-scrollbars',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  // Wait for the debugging endpoint to answer.
  let wsUrl = null;
  for (let attempt = 0; attempt < 60 && !wsUrl; attempt += 1) {
    await sleep(120);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      wsUrl = info.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
  }
  if (!wsUrl) {
    child.kill('SIGKILL');
    throw new Error('chrome never opened its debugging port for ' + mode);
  }

  const { WebSocket } = await import('ws');
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  let messageId = 0;
  const pending = new Map();
  const events = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++messageId;
      pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(method + ' timed out'))), 30000);
    });

  // Attach to the page target and drive it over the flat session.
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  // The game sizes its canvas from the document viewport, which headless Chrome reports smaller than
  // the window when browser chrome is present. Force the exact 16:9 viewport before navigation so the
  // drawing buffer is 1280x720 and not 1280x633.
  await send(
    'Emulation.setVisibleSize',
    { width: W, height: H },
    sessionId,
  ).catch(() => {});

  const consoleErrors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception');
    }
  });

  await send('Page.navigate', { url }, sessionId);

  // Poll the page's own flag: no guessing at timing.
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    await sleep(150);
    const probe = await send(
      'Runtime.evaluate',
      { expression: 'window.__shotReady === true', returnByValue: true },
      sessionId,
    );
    ready = probe?.result?.value === true;
  }

  // Two frames at the display rate after the flag, so the compositor has the final texture.
  await sleep(350);

  // The start and over screens are full-screen dialogs. Even at 55/78% alpha they flatten a dark map
  // into a uniform sheet, which is useless as submission art. Drop the dialog for the capture so the
  // frame shows the yard, and put it back afterwards — the HUD stays, it is part of what is being shown.
  await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const ov = document.querySelector('#overlay');
        if (!ov) return 'no-overlay';
        window.__overlayWas = ov.style.display;
        ov.style.display = 'none';
        return 'hidden';
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  await sleep(250);

  // `Page.captureScreenshot` with `fromSurface: true` can return the page WITHOUT its WebGL layer in
  // headless SwiftShader — the canvas reads 90 colours from inside the page but the PNG comes back
  // flat. So grab the WebGL pixels through the canvas itself, then draw the DOM on top of them.
  const grab = await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const c = document.querySelector('#game canvas');
        if (!c) return null;
        const g = c.getContext('webgl2') || c.getContext('webgl');
        const out = document.createElement('canvas');
        out.width = c.width; out.height = c.height;
        const ctx = out.getContext('2d');
        // Re-read the framebuffer into a 2D canvas so the pixel data survives serialisation.
        const px = new Uint8Array(c.width * c.height * 4);
        g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
        const img = ctx.createImageData(c.width, c.height);
        // WebGL origin is bottom-left; ImageData is top-left. Flip rows.
        for (let y = 0; y < c.height; y++) {
          const src = (c.height - 1 - y) * c.width * 4;
          img.data.set(px.subarray(src, src + c.width * 4), y * c.width * 4);
        }
        ctx.putImageData(img, 0, 0);
        return out.toDataURL('image/png');
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  const canvasDataUrl = grab?.result?.value || null;

  const pageShot = await send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false, fromSurface: true },
    sessionId,
  );

  // Number by the canonical shot order: rendering one mode must not overwrite 1-start.png with
  // 1-fight.png and leave the submitted set inconsistent.
  const CANON = ['start', 'buy', 'live', 'fight', 'plant', 'over'];
  const slot = CANON.indexOf(mode);
  const name = `${(slot >= 0 ? slot : index) + 1}-${mode}.png`;

  // headless SwiftShader drops the WebGL layer from Page.captureScreenshot, so the scene is grabbed
  // straight off the canvas and composited with the page shot. Without this the PNG is a flat sheet
  // even though the canvas inside the page clearly holds the rendered map.
  const composed = await send(
    'Runtime.evaluate',
    {
      expression: `(async () => {
        const load = (src) => new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = src;
        });
        const scene = await load(${JSON.stringify(canvasDataUrl)});
        const page = await load(${JSON.stringify('data:image/png;base64,' + (pageShot?.data || ''))});
        const cv = document.createElement('canvas');
        cv.width = ${W};
        cv.height = ${H};
        const ctx = cv.getContext('2d');
        ctx.drawImage(scene, 0, 0, ${W}, ${H});
        ctx.drawImage(page, 0, 0, ${W}, ${H});
        return cv.toDataURL('image/png');
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  ).catch(() => null);

  const composedUrl = composed?.result?.value || null;
  const pngBase64 = composedUrl
    ? composedUrl.replace(/^data:image\/png;base64,/, '')
    : pageShot.data;
  writeFileSync(join(OUT, name), Buffer.from(pngBase64, 'base64'));

  const diag = await send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({
        ready: window.__shotReady === true,
        canvas: !!document.querySelector('#game canvas'),
        size: (()=>{const c=document.querySelector('#game canvas'); return c?[c.width,c.height]:null})(),
        money: (document.body.innerText.match(/\\$[\\d,]+/)||[])[0] || null,
        round: (document.body.innerText.match(/ROUND \\d+|Buy · round \\d+/i)||[])[0] || null,
        // Read the live framebuffer from inside the render session. If the canvas has geometry here but
        // the saved PNG is flat, the fault is compositing; if it is already flat here, the fault is the
        // scene. Guessing between those two is how bad submissions happen.
        gl: (()=>{
          const c = document.querySelector('#game canvas'); if (!c) return null;
          const gl = c.getContext('webgl2') || c.getContext('webgl'); if (!gl) return null;
          const out = [];
          for (const fy of [0.35, 0.5, 0.65]) {
            const y = Math.floor(c.height * fy);
            const buf = new Uint8Array(c.width * 4);
            gl.readPixels(0, y, c.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            const uniq = new Set();
            for (let i = 0; i < c.width; i++) uniq.add(buf[i*4]+','+buf[i*4+1]+','+buf[i*4+2]);
            out.push({ fy, uniq: uniq.size });
          }
          return { bufSize: [c.width, c.height], scanlines: out };
        })()
      })`,
      returnByValue: true,
    },
    sessionId,
  );

  ws.close();
  child.kill('SIGKILL');
  await sleep(200);

  return { name, ready, errors: consoleErrors, diag: JSON.parse(diag.result.value || '{}') };
}

const results = [];
for (let i = 0; i < shots.length; i += 1) {
  const mode = shots[i];
  try {
    const r = await capture(mode, i);
    results.push(r);
    console.log(
      `${r.ready ? 'READY' : 'FAIL '} ${r.name.padEnd(14)} ${JSON.stringify(r.diag)}` +
        (r.errors.length ? ` ERRORS: ${r.errors.slice(0, 2).join(' | ')}` : ''),
    );
  } catch (e) {
    results.push({ name: `${i + 1}-${mode}.png`, ready: false, error: e.message });
    console.log(`FAIL  ${mode}: ${e.message}`);
  }
}

writeFileSync(join(OUT, 'render-report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ready);
console.log(`\n${results.length - failed.length}/${results.length} captured, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
