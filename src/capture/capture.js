/* global Imaging, api */
// Ventana oculta de captura. Mantiene un stream de pantalla abierto por
// monitor y guarda siempre el último fotograma (VideoFrame de WebCodecs).
// Recortar una zona es instantáneo: no hay que pedir una captura nueva.

const streams = new Map(); // sourceId → estado del stream
const opening = new Map(); // sourceId → promesa de apertura (evita streams duplicados)
const lastRaw = new Map(); // boxId → { rgba, w, h } para muestrear colores
const canvases = new Map(); // boxId → OffscreenCanvas reutilizable
const MAX_PIXELS = 3_000_000;

function openStream(req) {
  // Varios recuadros en la misma pantalla comparten un único stream
  let p = opening.get(req.sourceId);
  if (!p) {
    p = doOpenStream(req).finally(() => opening.delete(req.sourceId));
    opening.set(req.sourceId, p);
  }
  return p;
}

async function doOpenStream(req) {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: req.sourceId,
        minWidth: req.physW,
        maxWidth: req.physW,
        minHeight: req.physH,
        maxHeight: req.physH,
        maxFrameRate: req.fps,
      },
    },
  });
  const track = media.getVideoTracks()[0];
  const s = { track, fps: req.fps, latest: null, ts: 0, waiters: [], ended: false };
  const end = () => {
    s.ended = true;
    if (streams.get(req.sourceId) === s) streams.delete(req.sourceId);
  };
  track.addEventListener('ended', end);

  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  s.reader = reader;
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (s.latest) s.latest.close();
        s.latest = value;
        s.ts = performance.now();
        const waiting = s.waiters;
        s.waiters = [];
        waiting.forEach((fn) => fn());
      }
    } catch { /* stream cerrado */ } finally {
      end();
      if (s.latest) { s.latest.close(); s.latest = null; }
    }
  })();
  streams.set(req.sourceId, s);
  return s;
}

async function ensureStream(req) {
  const s = streams.get(req.sourceId);
  if (s && !s.ended) {
    if (s.fps !== req.fps) {
      s.fps = req.fps;
      s.track.applyConstraints({ frameRate: { max: req.fps } }).catch(() => {});
    }
    return s;
  }
  return openStream(req);
}

function nextFrame(s, after, timeout) {
  if (s.latest && s.ts > after) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    s.waiters.push(() => { clearTimeout(timer); resolve(); });
  });
}

function canvasFor(boxId, w, h) {
  let c = canvases.get(boxId);
  if (!c) {
    c = new OffscreenCanvas(w, h);
    canvases.set(boxId, c);
  } else if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

async function grab(req) {
  const t0 = performance.now();
  let s = await ensureStream(req);
  if (!s.latest) await nextFrame(s, 0, 1500);
  if (!s.latest) {
    // El stream no entrega imagen: se cierra y se abre de nuevo una vez
    closeStream(req.sourceId);
    s = await openStream(req);
    await nextFrame(s, 0, 1500);
  }
  // Tras ocultar la capa (modo de respaldo) se espera un fotograma nuevo
  if (req.fresh) await nextFrame(s, t0, 180);
  const frame = s.latest;
  if (!frame) throw new Error('la pantalla no envía imagen');

  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  const kx = fw / req.display.width;
  const ky = fh / req.display.height;
  const sx = Math.max(0, Math.round((req.rect.x - req.display.x) * kx));
  const sy = Math.max(0, Math.round((req.rect.y - req.display.y) * ky));
  const sw = Math.max(1, Math.min(fw - sx, Math.round(req.rect.width * kx)));
  const sh = Math.max(1, Math.min(fh - sy, Math.round(req.rect.height * ky)));

  let zoom = req.zoom;
  if (sw * sh * zoom * zoom > MAX_PIXELS) zoom = Math.sqrt(MAX_PIXELS / (sw * sh));
  const w = Math.max(1, Math.round(sw * zoom));
  const h = Math.max(1, Math.round(sh * zoom));

  const canvas = canvasFor(req.boxId, w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  lastRaw.set(req.boxId, { rgba: data, w, h });

  const pre = Imaging.preprocess(data, w, h, req.enhance, false);
  return {
    gray: pre.gray,
    w,
    h,
    pxX: w / req.rect.width,
    pxY: h / req.rect.height,
    sig: Imaging.signature(pre.gray, w, h),
    mean: pre.mean,
    std: pre.std,
  };
}

function sample({ boxId, rects }) {
  const raw = lastRaw.get(boxId);
  if (!raw) return [];
  return Imaging.sampleColors(raw.rgba, raw.w, raw.h, rects);
}

function closeStream(sourceId) {
  const s = streams.get(sourceId);
  if (!s) return;
  streams.delete(sourceId);
  s.ended = true;
  s.reader?.cancel().catch(() => {});
  s.track.stop();
}

function release() {
  for (const id of [...streams.keys()]) closeStream(id);
  lastRaw.clear();
  canvases.clear();
}

api.capture.onRequest(async ({ id, type, payload }) => {
  try {
    let data;
    if (type === 'grab') data = await grab(payload);
    else if (type === 'sample') data = sample(payload);
    else if (type === 'release') data = release();
    else if (type === 'forget') { lastRaw.delete(payload.boxId); canvases.delete(payload.boxId); }
    api.capture.reply({ id, ok: true, data });
  } catch (err) {
    api.capture.reply({ id, ok: false, error: String((err && err.message) || err) });
  }
});
