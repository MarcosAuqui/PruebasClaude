// Idiomas que el OCR (Tesseract) debe cargar según el idioma de origen.
// "auto" cubre los idiomas de alfabeto latino más comunes; para asiáticos,
// árabe o cirílico conviene elegir el idioma de origen explícitamente.
const OCR_LANGS = {
  auto: 'eng+spa+fra+deu+ita+por',
  en: 'eng',
  es: 'spa',
  fr: 'fra',
  de: 'deu',
  it: 'ita',
  pt: 'por',
  ru: 'rus',
  ja: 'jpn',
  ko: 'kor',
  'zh-CN': 'chi_sim',
  ar: 'ara',
};

module.exports = { OCR_LANGS };
