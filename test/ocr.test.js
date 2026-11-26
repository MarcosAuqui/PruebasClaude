// Prueba real del OCR con los modelos incluidos (npm run prepare-ocr).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OcrPool } = require('../src/main/ocr');

const bundled = path.join(__dirname, '..', 'build', 'tessdata');
const has = fs.existsSync(path.join(bundled, 'eng.traineddata.gz'));

function readPGM(name) {
  const b = fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.pgm`));
  const m = /^P5\n(\d+) (\d+)\n255\n/.exec(b.toString('latin1', 0, 30));
  return { w: +m[1], h: +m[2], gray: new Uint8Array(b.subarray(m[0].length)) };
}

const EXPECT = {
  eng: ['latin', 'The weather is beautiful today'],
  jpn: ['jpn', '今日はとても良い天気ですね'],
  rus: ['rus', 'Сегодня прекрасная погода'],
  kor: ['kor', '오늘 날씨가 정말 좋네요'],
  chi: ['chi_sim', '今天天气非常好，我们去公园吧'],
  ara: ['ara', 'الطقس جميل جدا اليوم'],
  hin: ['hin', 'आज मौसम बहुत अच्छा है'],
  spa: ['latin', 'El niño comió una manzana roja'],
};

test('detección automática de alfabeto y cambios entre idiomas', { skip: !has && 'ejecuta npm run prepare-ocr' }, async () => {
  const pool = new OcrPool({ cachePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-')), bundledPath: bundled });
  try {
    const memo = { locked: null };
    for (const k of ['eng', 'jpn', 'rus', 'eng', 'kor', 'chi', 'ara', 'hin', 'spa']) {
      const { w, h, gray } = readPGM(k);
      const r = await pool.recognize(gray, w, h, 'auto', memo);
      assert.equal(r.text, EXPECT[k][1], `texto de ${k}`);
      const lockedOk = EXPECT[k][0] === 'latin' ? memo.locked.startsWith('eng+') : memo.locked === EXPECT[k][0];
      assert.ok(lockedOk || memo.locked === 'chi_sim' || memo.locked === 'jpn', `alfabeto de ${k}: ${memo.locked}`);
    }
    const blank = new Uint8Array(300 * 60).fill(255);
    assert.equal((await pool.recognize(blank, 300, 60, 'auto', { locked: null })).paragraphs.length, 0);
    const ja = readPGM('jpn');
    assert.equal((await pool.recognize(ja.gray, ja.w, ja.h, 'ja', {})).text, EXPECT.jpn[1]);
  } finally {
    await pool.dispose();
  }
});
