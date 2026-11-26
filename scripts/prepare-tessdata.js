// Copia los modelos de OCR de los alfabetos de la detección automática a
// build/tessdata para incluirlos en el instalador (funciona sin internet).
const fs = require('fs');
const path = require('path');

const LANGS = ['eng', 'spa', 'fra', 'deu', 'ita', 'por', 'rus', 'jpn', 'chi_sim', 'kor', 'ara', 'hin'];
const out = path.join(__dirname, '..', 'build', 'tessdata');
fs.mkdirSync(out, { recursive: true });

let total = 0;
for (const lang of LANGS) {
  const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
  const src = path.join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`);
  const dst = path.join(out, `${lang}.traineddata.gz`);
  fs.copyFileSync(src, dst);
  total += fs.statSync(dst).size;
}
console.log(`Modelos OCR listos: ${LANGS.length} idiomas, ${(total / 1048576).toFixed(1)} MB → build/tessdata`);
