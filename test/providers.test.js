const test = require('node:test');
const assert = require('node:assert');

const calls = [];
let handler = () => ({ status: 500, body: {} });
globalThis.fetch = async (url, opts = {}) => {
  const call = { url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
  calls.push(call);
  const { status, body } = handler(call);
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
};
const tr = require('../src/main/translator');

const gtx = { status: 200, body: [[['Hola (gratis)', 'Hello']], null, 'en'] };
const sorry = { status: 429, body: '<html><title>Sorry...</title>Our systems have detected unusual traffic</html>' };
const mm = (text) => ({ status: 200, body: { responseData: { translatedText: text, match: 1 }, responseStatus: 200, quotaFinished: false } });
function setup(opts) { tr._reset(); calls.length = 0; const notices = []; tr.configure({ ...opts, onNotice: (t) => notices.push(t) }); return notices; }

test('DeepL: petición correcta (clave Free) y respuesta', async () => {
  setup({ provider: 'deepl', keys: { deepl: 'abc123:fx' } });
  handler = (c) => (c.url.includes('deepl') ? { status: 200, body: { translations: [{ detected_source_language: 'EN', text: 'Hola, ¿qué tal?' }] } } : gtx);
  const r = await tr.translate('Hello, how are you?', 'es');
  assert.deepEqual(r, { translated: 'Hola, ¿qué tal?', detected: 'en', provider: 'DeepL' });
  const c = calls[0];
  assert.equal(c.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, 'DeepL-Auth-Key abc123:fx');
  assert.deepEqual(c.body, { text: ['Hello, how are you?'], target_lang: 'ES' });
});

test('DeepL: clave Pro, códigos de idioma y chino', async () => {
  setup({ provider: 'deepl', keys: { deepl: 'pro-key' } });
  handler = () => ({ status: 200, body: { translations: [{ detected_source_language: 'ZH', text: 'Hello' }] } });
  const r = await tr.translate('你好', 'en', 'zh-CN');
  assert.equal(calls[0].url, 'https://api.deepl.com/v2/translate');
  assert.deepEqual(calls[0].body, { text: ['你好'], target_lang: 'EN-US', source_lang: 'ZH' });
  assert.equal(r.detected, 'zh-CN');
  await tr.translate('Olá', 'pt');
  assert.equal(calls[1].body.target_lang, 'PT-BR');
});

test('DeepL: clave inválida → respaldo a Google gratis con un solo aviso', async () => {
  const notices = setup({ provider: 'deepl', keys: { deepl: 'mala:fx' } });
  handler = (c) => (c.url.includes('deepl') ? { status: 403, body: { message: 'Forbidden' } } : gtx);
  const r1 = await tr.translate('Hello', 'es');
  const r2 = await tr.translate('Bye', 'es');
  assert.equal(r1.provider, 'Google gratuito');
  assert.equal(r2.provider, 'Google gratuito');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /clave de DeepL no es válida/);
});

test('DeepL: sin respaldo, el error llega al usuario', async () => {
  setup({ provider: 'deepl', fallback: false, keys: { deepl: 'k:fx' } });
  handler = () => ({ status: 456, body: {} });
  await assert.rejects(tr.translate('Hello', 'es'), /cuota mensual de DeepL/);
});

test('DeepL: idioma no admitido (hindi) → Google gratis para ese idioma', async () => {
  const notices = setup({ provider: 'deepl', keys: { deepl: 'k:fx' } });
  handler = (c) => (c.url.includes('deepl') ? { status: 500, body: {} } : gtx);
  const r = await tr.translate('Hello', 'hi');
  assert.equal(r.provider, 'Google gratuito');
  assert.ok(calls.every((c) => !c.url.includes('deepl')), 'no se llama a DeepL');
  assert.equal(notices.length, 1);
});

test('Google Cloud: petición, entidades HTML y clave inválida', async () => {
  setup({ provider: 'google-cloud', keys: { 'google-cloud': 'AIzaTEST' } });
  handler = () => ({ status: 200, body: { data: { translations: [{ translatedText: 'L&#39;eau &amp; le &quot;vin&quot;', detectedSourceLanguage: 'en' }] } } });
  const r = await tr.translate('Water & "wine"', 'fr');
  assert.equal(r.translated, 'L\'eau & le "vin"');
  assert.equal(calls[0].url, 'https://translation.googleapis.com/language/translate/v2?key=AIzaTEST');
  assert.deepEqual(calls[0].body, { q: ['Water & "wine"'], target: 'fr', format: 'text' });
  handler = () => ({ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } });
  await assert.rejects(tr.testKey('google-cloud', 'AIzaBAD'), /clave de Google Cloud no es válida/);
});

test('sin clave guardada se usa Google gratis', async () => {
  setup({ provider: 'deepl', keys: { deepl: '' } });
  handler = () => gtx;
  assert.equal(tr.activeProvider(), 'google-free');
  assert.equal((await tr.translate('Hello', 'es')).provider, 'Google gratuito');
});

test('429 de DeepL: pausa solo para DeepL; Google gratis sigue como respaldo', async () => {
  setup({ provider: 'deepl', keys: { deepl: 'k:fx' } });
  handler = (c) => (c.url.includes('deepl') ? { status: 429, body: {} } : gtx);
  const r = await tr.translate('Hello', 'es');
  assert.equal(r.provider, 'Google gratuito');
  assert.ok(tr.cooldownRemaining('deepl') > 0);
  assert.equal(tr.cooldownRemaining('google-free'), 0);
  const before = calls.filter((c) => c.url.includes('deepl')).length;
  await tr.translate('Other text', 'es');
  assert.equal(calls.filter((c) => c.url.includes('deepl')).length, before, 'no vuelve a llamar a DeepL durante la pausa');
});

test('testKey: prueba sin guardar ni usar la caché', async () => {
  setup({});
  handler = () => ({ status: 200, body: { translations: [{ detected_source_language: 'EN', text: 'Hola, ¿cómo estás?' }] } });
  assert.equal(await tr.testKey('deepl', ' nueva:fx '), 'Hola, ¿cómo estás?');
  assert.equal(calls[0].headers.Authorization, 'DeepL-Auth-Key nueva:fx');
  await assert.rejects(tr.testKey('deepl', '  '), /escribe una clave/);
  await assert.rejects(tr.testKey('google-free', 'x'), /no válido/);
});

test('Google bloquea («Sorry…») → MyMemory automáticamente, un aviso y pausa larga para Google', async () => {
  const notices = setup({});
  handler = (c) => (c.url.includes('googleapis') ? sorry : mm('Buenas noches, amigos'));
  const r = await tr.translate('Good evening, friends', 'es');
  assert.deepEqual(r, { translated: 'Buenas noches, amigos', detected: 'en', provider: 'MyMemory' });
  const mmCall = calls.find((c) => c.url.includes('mymemory'));
  assert.match(mmCall.url, /langpair=en\|es/);
  assert.ok(tr.cooldownRemaining('google-free') > 25 * 60_000, 'no se insiste con Google en 30 min');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /MyMemory/);
  calls.length = 0;
  await tr.translate('See you tomorrow', 'es');
  assert.ok(calls.every((c) => !c.url.includes('googleapis')), 'durante la pausa ni se intenta Google');
});

test('MyMemory: detecta el idioma localmente y no traduce si ya está en el idioma destino', async () => {
  setup({});
  handler = (c) => (c.url.includes('googleapis') ? sorry : mm('Hello'));
  await tr.translate('今日はとても良い天気ですね', 'en');
  assert.match(calls.find((c) => c.url.includes('mymemory')).url, /langpair=ja\|en/);
  calls.length = 0;
  const same = await tr.translate('Hola, ¿cómo estás?', 'es');
  assert.equal(same.translated, 'Hola, ¿cómo estás?');
  assert.equal(calls.filter((c) => c.url.includes('mymemory')).length, 0);
});

test('MyMemory: textos largos se dividen bajo el límite de 500 bytes', async () => {
  setup({});
  handler = (c) => (c.url.includes('googleapis') ? sorry : mm('trozo'));
  const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} of a long paragraph.`).join(' ');
  const r = await tr.translate(long, 'es');
  const pieces = calls.filter((c) => c.url.includes('mymemory'));
  assert.ok(pieces.length >= 3, `trozos: ${pieces.length}`);
  for (const c of pieces) {
    const q = decodeURIComponent(new URL(c.url).searchParams.get('q'));
    assert.ok(Buffer.byteLength(q) <= 450);
  }
  assert.equal(r.translated, Array(pieces.length).fill('trozo').join(' '));
});

test('todos los gratuitos limitados → error claro con cuándo se reintenta', async () => {
  setup({});
  handler = (c) => (c.url.includes('googleapis') ? sorry : { status: 200, body: { responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }, responseStatus: 429 } });
  await assert.rejects(tr.translate('Hello there', 'es'), (e) => e.code === 'COOLDOWN' && /gratuitos están limitando/.test(e.message) && /Microsoft o DeepL/.test(e.message));
  assert.ok(tr.cooldownRemaining('mymemory') > 50 * 60_000, 'cuota diaria: pausa de 1 h');
  const n = calls.length;
  await assert.rejects(tr.translate('Other', 'es'), (e) => e.code === 'COOLDOWN');
  assert.equal(calls.length, n, 'no se envía nada durante la pausa');
});

test('Microsoft: petición, región, chino y clave inválida', async () => {
  setup({ provider: 'microsoft', keys: { microsoft: 'ms-key' }, msRegion: 'westeurope' });
  handler = () => ({ status: 200, body: [{ detectedLanguage: { language: 'en', score: 1 }, translations: [{ text: '你好，朋友们', to: 'zh-Hans' }] }] });
  const r = await tr.translate('Hello friends', 'zh-CN');
  assert.deepEqual(r, { translated: '你好，朋友们', detected: 'en', provider: 'Microsoft' });
  const c = calls[0];
  assert.equal(c.url, 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans');
  assert.equal(c.headers['Ocp-Apim-Subscription-Key'], 'ms-key');
  assert.equal(c.headers['Ocp-Apim-Subscription-Region'], 'westeurope');
  assert.deepEqual(c.body, [{ Text: 'Hello friends' }]);
  handler = () => ({ status: 200, body: [{ translations: [{ text: 'Hola' }] }] });
  await tr.translate('Hello', 'es', 'en');
  assert.match(calls[1].url, /&from=en$/);
  handler = () => ({ status: 401, body: { error: { code: 401000, message: 'Access denied due to invalid subscription key' } } });
  await assert.rejects(tr.testKey('microsoft', 'bad', ''), /clave de Microsoft no es válida/);
  assert.equal(calls[2].headers['Ocp-Apim-Subscription-Region'], undefined, 'recurso global: sin región');
});

test('Microsoft con cuota agotada → traductor gratuito con aviso', async () => {
  const notices = setup({ provider: 'microsoft', keys: { microsoft: 'k' } });
  handler = (c) => (c.url.includes('microsoft') ? { status: 403, body: { error: { code: 403001, message: 'quota exceeded' } } } : gtx);
  const r = await tr.translate('Hello', 'es');
  assert.equal(r.provider, 'Google gratuito');
  assert.match(notices[0], /cuota agotada/);
});
