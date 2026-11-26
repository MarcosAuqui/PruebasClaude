const test = require('node:test');
const assert = require('node:assert');
const Imaging = require('../src/shared/imaging');
const config = require('../src/main/config');
const { History } = require('../src/main/history');
const { groupParagraphs, toPGM } = require('../src/main/ocr');
const { similarity } = require('../src/main/engine');

function rgbaFill(w, h, bg, rect, fg) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = rect && x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3];
    const c = inside ? fg : bg; const j = (y * w + x) * 4;
    px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2]; px[j + 3] = 255;
  }
  return px;
}

test('preprocess invierte fondos oscuros y no los claros', () => {
  const dark = Imaging.preprocess(rgbaFill(40, 20, [10, 10, 10], [5, 5, 15, 15], [250, 250, 250]), 40, 20, 'auto');
  assert.equal(dark.inverted, true);
  assert.ok(dark.gray[0] > 200, 'el fondo pasa a claro');
  const light = Imaging.preprocess(rgbaFill(40, 20, [245, 245, 245], [5, 5, 15, 15], [20, 20, 20]), 40, 20, 'auto');
  assert.equal(light.inverted, false);
  assert.ok(light.gray[0] > 200);
  const strong = Imaging.preprocess(rgbaFill(40, 20, [10, 10, 10], [5, 5, 15, 15], [250, 250, 250]), 40, 20, 'strong');
  assert.ok([...strong.gray].every((v) => v === 0 || v === 255), 'binarizada');
  assert.equal(strong.gray[0], 255, 'fondo blanco');
  assert.equal(strong.gray[6 * 40 + 6], 0, 'texto negro');
  const off = Imaging.preprocess(rgbaFill(4, 4, [100, 100, 100]), 4, 4, 'off');
  assert.equal(off.gray[0], 100);
});

test('preprocess con orden BGRA', () => {
  const px = rgbaFill(2, 1, [0, 0, 255]); // azul en RGBA = rojo en BGRA
  const a = Imaging.preprocess(px, 2, 1, 'off', false).gray[0];
  const b = Imaging.preprocess(px, 2, 1, 'off', true).gray[0];
  assert.ok(b > a);
});

test('signature y sigDiff detectan cambios', () => {
  const g1 = new Uint8Array(200 * 50).fill(200);
  const g2 = g1.slice(); for (let i = 0; i < 2000; i++) g2[i] = 0;
  const s1 = Imaging.signature(g1, 200, 50);
  assert.equal(Imaging.sigDiff(s1, Imaging.signature(g1, 200, 50)), 0);
  assert.ok(Imaging.sigDiff(s1, Imaging.signature(g2, 200, 50)) > 5);
  assert.equal(Imaging.sigDiff(null, s1), Infinity);
  assert.equal(Imaging.signature(new Uint8Array(1), 1, 1).length, 48 * 12);
});

test('sampleColors devuelve fondo y texto con contraste', () => {
  const w = 100; const h = 40;
  const px = rgbaFill(w, h, [255, 240, 0], [20, 12, 80, 28], [200, 0, 0]);
  // simulamos texto: rayas rojas dentro del rectángulo
  for (let y = 12; y < 28; y++) for (let x = 20; x < 80; x++) if ((x >> 2) % 2) { const j = (y * w + x) * 4; px[j] = 255; px[j + 1] = 240; px[j + 2] = 0; }
  const [c] = Imaging.sampleColors(px, w, h, [{ x0: 18, y0: 10, x1: 82, y1: 30 }]);
  assert.deepEqual(c.bg, [255, 240, 0]);
  assert.ok(Imaging.contrast(c.fg, c.bg) >= 3);
  assert.equal(Imaging.sampleColors(px, w, h, [{ x0: 50, y0: 50, x1: 40, y1: 40 }])[0], null);
});

test('config.sanitize repara datos dañados', () => {
  assert.equal(config.sanitize(null).profiles.length, 1);
  const s = config.sanitize({
    settings: { speed: 'x', enhance: 'strong', tts: { rate: 9 } },
    profiles: [{ id: 'a', name: 'A', boxes: [{ source: 'zz', target: 'en', mode: 'nope', rect: { x: 1, y: 2, width: 3, height: 'x' } }] }, { id: 'a' }],
    activeProfileId: 'missing',
  });
  assert.equal(s.settings.speed, 'normal');
  assert.equal(s.settings.enhance, 'strong');
  assert.equal(s.settings.tts.rate, 2);
  assert.equal(s.profiles.length, 1);
  assert.equal(s.activeProfileId, 'a');
  const b = s.profiles[0].boxes[0];
  assert.equal(b.source, 'auto'); assert.equal(b.target, 'en'); assert.equal(b.mode, 'inplace'); assert.equal(b.rect, null);
});

test('history: deduplica y exporta en todos los formatos', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const h = new History(path.join(dir, 'h.json'));
  const base = { boxId: 'b', boxName: '1', detected: 'en', target: 'es' };
  assert.ok(h.add({ ...base, original: 'Hi "you"', translated: 'Hola', ts: 1000 }));
  assert.equal(h.add({ ...base, original: 'Hi "you"', translated: 'Hola', ts: 1500 }), null);
  assert.ok(h.add({ ...base, original: 'Bye', translated: 'Adiós', ts: 4000 }));
  assert.match(History.format(h.list(), 'csv'), /"Hi ""you"""/);
  assert.match(History.format(h.list(), 'srt'), /^1\n00:00:00,000 --> 00:00:03,000\nHola/);
  assert.equal(JSON.parse(History.format(h.list(), 'json')).length, 2);
  assert.match(History.format(h.list(), 'txt'), /→ Adiós/);
  await h.export(path.join(dir, 'out.csv'), 'csv');
  h.flush();
  assert.equal(new History(path.join(dir, 'h.json')).list().length, 2);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.equal(new History(path.join(dir, 'bad.json')).list().length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('bad.json.damaged')));
});

test('groupParagraphs agrupa líneas cercanas y separa bloques', () => {
  const L = (t, x0, y0, x1, y1) => ({ text: t, bbox: { x0, y0, x1, y1 }, conf: 90 });
  const p = groupParagraphs([
    L('Hello wor-', 10, 10, 200, 40), L('ld again', 10, 45, 180, 75),
    L('Footer', 10, 200, 100, 230),
    L('今日は', 300, 10, 400, 40), L('天気', 300, 45, 380, 75),
  ]);
  assert.equal(p.length, 3);
  assert.equal(p.find((x) => x.text.startsWith('Hello')).text, 'Hello world again');
  assert.ok(p.some((x) => x.text === '今日は天気'));
  assert.ok(p.some((x) => x.text === 'Footer'));
});

test('toPGM arma una cabecera válida', () => {
  const buf = toPGM(new Uint8Array([1, 2, 3, 4, 5, 6]), 3, 2);
  assert.equal(buf.slice(0, 11).toString(), 'P5\n3 2\n255\n');
  assert.equal(buf.length, 17);
});

test('similarity', () => {
  assert.equal(similarity('Hola mundo', 'hola, mundo!'), 1);
  assert.ok(similarity('El clima es bueno', 'The weather is nice') < 0.4);
  assert.equal(similarity('', 'x'), 0);
});

test('translator: caché, reintento y errores', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (url.includes('fail500') && calls < 2) return { ok: false, status: 500 };
    if (url.includes('bad400')) return { ok: false, status: 400 };
    return { ok: true, json: async () => [[['Hola ', 'Hello '], ['mundo', 'world']], null, 'en'] };
  };
  delete require.cache[require.resolve('../src/main/translator')];
  const { translate } = require('../src/main/translator');
  assert.deepEqual(await translate('Hello world', 'es'), { translated: 'Hola mundo', detected: 'en', provider: 'Google gratuito' });
  await translate('Hello world', 'es');
  assert.equal(calls, 1, 'segunda vez sale de la caché');
  calls = 0;
  assert.equal((await translate('fail500', 'es')).translated, 'Hola mundo');
  await assert.rejects(translate('bad400', 'es'), /400/);
});
