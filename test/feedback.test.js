// Reproduce el bucle de realimentación: el sistema NO excluye el recuadro de
// la captura (o el fotograma llega tarde al ocultarlo), de modo que el OCR
// lee nuestra propia traducción pintada encima.
const test = require('node:test');
const assert = require('node:assert');
const { BoxRunner } = require('../src/main/engine');

// Servidor de traducción falso (se instala antes de cargar el traductor real)
const server = { requests: 0, mode: 'ok' };
globalThis.fetch = async (url) => {
  server.requests++;
  if (server.mode === '429') return { ok: false, status: 429 };
  return { ok: true, json: async () => [[[TRANSLATED, 'x']], null, 'en'] };
};
const realTranslator = require('../src/main/translator');

const ORIGINAL = 'Hello my friends, welcome to the live stream';
const TRANSLATED = 'Hola mis amigos, bienvenidos a la transmisión en vivo';

function sig(seed) { const s = new Uint8Array(576); for (let i = 0; i < 576; i++) s[i] = (seed * 37 + i * 11) % 256; return s; }

function makeWorld({
  excludes = false, lagFrames = 3, noisyOcr = false, rateLimitAfter = Infinity, real = false, garbled = false, acceptBlink = false,
}) {
  const world = {
    calls: 0, renders: 0, clears: 0, results: 0, layerOn: false, hidden: false, hiddenFrames: 0, frame: 0, errors: [], hides: 0, flips: 0, fallbacks: 0,
  };
  const bw = {
    alive: true,
    box: { id: 'b', name: '1', source: 'auto', target: 'es', mode: 'inplace', visible: true },
    captureRect: () => ({ x: 0, y: 0, width: 400, height: 100 }),
    send(ch, data) {
      if (ch === 'overlay:render') {
        world.renders++;
        const on = data.items.length > 0;
        if (on !== world.layerOn) world.flips++;
        world.layerOn = on;
        if (data.items[0]) world.shown = data.items[0].text;
      }
      if (ch === 'overlay:clear') { world.clears++; if (world.layerOn) world.flips++; world.layerOn = false; }
    },
    setStatus() {},
    hideLayer: async () => { world.hidden = true; world.hiddenFrames = 0; world.hides++; },
    showLayer() { world.hidden = false; },
  };
  const ctx = {
    exclusion: { works: true, acceptBlink },
    settings: () => ({ speed: 'fast', enhance: 'auto' }),
    capture: {
      async grab(req) {
        world.frame++;
        if (world.hidden) world.hiddenFrames += req.freshFrames || 1;
        // La captura ve la traducción si la capa está pintada, el sistema no
        // la excluye y (si se ocultó) el fotograma aún no se actualizó.
        const seesLayer = world.layerOn && !excludes && (!world.hidden || world.hiddenFrames <= lagFrames);
        const noise = noisyOcr ? world.frame % 7 : 0;
        const base = world.original ? 50 : 2;
        return { gray: seesLayer ? 'ES' : `EN${noise}`, w: 400, h: 100, pxX: 1, pxY: 1, sig: sig(seesLayer ? 1 : base + noise), mean: 120, std: 40 };
      },
      sample: async () => [],
    },
    ocr: {
      async recognize(token) {
        let text = token === 'ES' ? (world.shown || TRANSLATED) : (world.original || ORIGINAL);
        // Lectura deformada de nuestra propia capa (letra pequeña, otros colores)
        if (token === 'ES' && garbled) text = 'Hoal mls arnigos, bienvenldos a l tansmision en viv';
        // OCR de vídeo en vivo: pequeñas variaciones entre fotogramas
        if (token.startsWith('EN') && token !== 'EN0') text = text.replace('live', ['live', 'Iive', 'live.', 'llve', 'live', 'liue', 'live'][+token[2]]);
        return { paragraphs: [{ text, bbox: { x0: 10, y0: 10, x1: 390, y1: 40 }, lineH: 30, lineCount: 1, conf: 90 }], conf: 90, medianLineH: 30, text };
      },
    },
    async translate(text) {
      world.calls++;
      if (world.calls > rateLimitAfter) { const e = new Error('demasiadas solicitudes, espera un momento'); e.status = 429; throw e; }
      const isEs = /^(Hola|Ahora|Hoal)/.test(text);
      if (isEs) return { translated: text, detected: 'es' };
      return { translated: text.startsWith('Now') ? 'Ahora empieza el partido final' : TRANSLATED, detected: 'en' };
    },
    emit(type, d) { if (type === 'fallback-caption') { world.fallbacks++; if (world.realModeSwitch) bw.box.mode = 'caption'; } if (type === 'result') world.results++; if (type === 'box-status' && d.level === 'error') world.errors.push(d.text); },
  };
  if (real) ctx.translate = (...a) => { world.calls++; return realTranslator.translate(...a); };
  return { world, runner: new BoxRunner(bw, ctx), ctx };
}

async function run(opts, ms = 6000) {
  const w = makeWorld(opts);
  w.runner.start();
  await new Promise((r) => setTimeout(r, ms));
  w.runner.stop();
  await new Promise((r) => setTimeout(r, 200));
  return w;
}

test('sin exclusión de captura: no oscila ni repite solicitudes', async () => {
  const { world } = await run({ excludes: false, lagFrames: 3 });
  console.log('   sin exclusión:', JSON.stringify({ solicitudes: world.calls, resultados: world.results, borrados: world.clears }));
  assert.ok(world.calls <= 3, `solicitudes: ${world.calls}`);
  assert.ok(world.results <= 1, `resultados en historial: ${world.results}`);
});

test('vídeo en vivo con OCR ruidoso: pocas solicitudes', async () => {
  const { world } = await run({ excludes: true, noisyOcr: true });
  console.log('   vídeo ruidoso:', JSON.stringify({ solicitudes: world.calls, resultados: world.results }));
  assert.ok(world.calls <= 4, `solicitudes: ${world.calls}`);
  assert.ok(world.results <= 2, `resultados: ${world.results}`);
});

test('límite del traductor (429): pausa global, sin insistir', async () => {
  realTranslator._reset();
  server.requests = 0;
  server.mode = '429';
  const { world } = await run({ excludes: true, noisyOcr: true, real: true }, 5000);
  console.log('   con 429:', JSON.stringify({ peticionesHTTP: server.requests, avisos: world.errors.length }));
  assert.equal(server.requests, 2, 'una petición a cada servicio gratuito y luego pausa');
  assert.ok(realTranslator.cooldownRemaining() > 0, 'pausa activa');
  server.mode = 'ok';
});

test('espaciado y agrupación de peticiones del traductor', async () => {
  realTranslator._reset();
  server.requests = 0;
  server.mode = 'ok';
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4, 5].map((i) => realTranslator.translate(`frase ${i}`, 'es')));
  const spacing = Date.now() - t0;
  await Promise.all([1, 2, 3].map(() => realTranslator.translate('igual', 'es')));
  console.log('   espaciado:', JSON.stringify({ peticiones: server.requests, ms: spacing }));
  assert.equal(server.requests, 6, '5 distintas + 1 agrupada');
  assert.ok(spacing >= 4 * 170, 'respeta el espaciado mínimo');
});

test('sin exclusión de captura: sigue detectando el texto nuevo de debajo', async () => {
  const w = makeWorld({ excludes: false, lagFrames: 3, acceptBlink: true });
  w.runner.start();
  await new Promise((r) => setTimeout(r, 2500));
  w.world.original = 'Now the final match begins';
  await new Promise((r) => setTimeout(r, 4000));
  w.runner.stop();
  console.log('   texto nuevo:', JSON.stringify({ solicitudes: w.world.calls, resultados: w.world.results, pintado: w.world.shown }));
  assert.equal(w.world.shown, 'Ahora empieza el partido final');
  assert.ok(w.world.calls <= 3, `solicitudes: ${w.world.calls}`);
});

test('sistema sin captura limpia posible: pasa a subtítulo en vez de insistir', async () => {
  const w = makeWorld({ excludes: false, lagFrames: 99, acceptBlink: true });
  let fallback = 0;
  const emit = w.ctx.emit;
  w.ctx.emit = (type, d) => { if (type === 'fallback-caption') fallback++; emit(type, d); };
  w.runner.start();
  await new Promise((r) => setTimeout(r, 8000));
  w.runner.stop();
  console.log('   sin salida:', JSON.stringify({ solicitudes: w.world.calls, cambioASubtitulo: fallback }));
  assert.equal(fallback, 1, 'un solo aviso');
  assert.ok(w.world.calls <= 2, `solicitudes: ${w.world.calls}`);
});

test('TU CASO: lectura deformada de la propia capa → sin bucle inglés/español', async () => {
  // Sin el cambio real de modo (defensa del motor) y con él (como en la app)
  for (const realModeSwitch of [false, true]) {
    const w = makeWorld({ excludes: false, lagFrames: 99, garbled: true });
    w.world.realModeSwitch = realModeSwitch;
    w.runner.start();
    await new Promise((r) => setTimeout(r, 6000));
    w.runner.stop();
    const { world } = w;
    console.log('   deformada' + (realModeSwitch ? ' (app real)' : ' (defensa)') + ':', JSON.stringify({ solicitudes: world.calls, alternancias: world.flips, ocultaciones: world.hides, aSubtitulo: world.fallbacks }));
    assert.ok(world.flips <= 2, `la capa alterna ${world.flips} veces`);
    assert.ok(world.calls <= 2, `solicitudes: ${world.calls}`);
    assert.equal(world.fallbacks, 1, 'pasa a subtítulo y avisa una vez');
    assert.ok(world.hides <= 1, `no parpadea: ${world.hides} ocultaciones`);
  }
});

test('modo respaldo aceptado: la capa se oculta como mucho cada 0,8 s en «Rápida» (no en cada lectura)', async () => {
  const { world } = await run({ excludes: false, lagFrames: 1, acceptBlink: true }, 7500);
  console.log('   parpadeos:', JSON.stringify({ ocultaciones: world.hides, alternancias: world.flips }));
  assert.ok(world.hides <= 10, `ocultaciones en 7,5 s: ${world.hides}`);
  assert.ok(world.flips <= 2);
});
