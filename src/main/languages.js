// Idiomas soportados. [código del traductor, nombre, modelo OCR de Tesseract]
const LANGS = [
  ['en', 'Inglés', 'eng'],
  ['es', 'Español', 'spa'],
  ['fr', 'Francés', 'fra'],
  ['de', 'Alemán', 'deu'],
  ['it', 'Italiano', 'ita'],
  ['pt', 'Portugués', 'por'],
  ['nl', 'Neerlandés', 'nld'],
  ['pl', 'Polaco', 'pol'],
  ['tr', 'Turco', 'tur'],
  ['sv', 'Sueco', 'swe'],
  ['ru', 'Ruso', 'rus'],
  ['uk', 'Ucraniano', 'ukr'],
  ['el', 'Griego', 'ell'],
  ['ar', 'Árabe', 'ara'],
  ['he', 'Hebreo', 'heb'],
  ['hi', 'Hindi', 'hin'],
  ['th', 'Tailandés', 'tha'],
  ['vi', 'Vietnamita', 'vie'],
  ['id', 'Indonesio', 'ind'],
  ['ja', 'Japonés', 'jpn'],
  ['ko', 'Coreano', 'kor'],
  ['zh-CN', 'Chino simplificado', 'chi_sim'],
  ['zh-TW', 'Chino tradicional', 'chi_tra'],
];

// Grupos que se prueban en "Detectar automáticamente". El primero (latino)
// se intenta siempre primero porque es el más común y está precargado.
const AUTO_GROUPS = {
  latin: 'eng+spa+fra+deu+ita+por',
  cyrillic: 'rus',
  japanese: 'jpn',
  chinese: 'chi_sim',
  korean: 'kor',
  arabic: 'ara',
  devanagari: 'hin',
};

const TESS_BY_CODE = Object.fromEntries(LANGS.map(([c, , t]) => [c, t]));
const CODES = new Set(LANGS.map(([c]) => c));

module.exports = { LANGS, AUTO_GROUPS, TESS_BY_CODE, CODES };
