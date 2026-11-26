const test = require('node:test');
const assert = require('node:assert');

const calls = [];
let handler = () => ({ status: 500, body: {} });
globalThis.fetch = async (url, opts = {}) => {
  const call = { url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
  calls.push(call);
  const { status, body } = handler(call);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const tr = require('../src/main/translator');

const gtx = { status: 200, body: [[['Hola (gratis)', 'Hello']], null, 'en'] };
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
