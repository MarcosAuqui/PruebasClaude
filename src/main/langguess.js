// Detección rápida y local del idioma de un texto (sin red).
// 1) Por alfabeto (japonés, chino, coreano, cirílico, árabe…).
// 2) En alfabeto latino, por palabras muy frecuentes y signos propios.

const WORDS = {
  en: 'the and is are was were to of in that it you for on with this have be not they we what at from by or but your can will all there their so if my me he she our an do no',
  es: 'el la los las de que y en un una es por con para no se lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus está estoy estás hola gracias',
  fr: 'le la les de des du et en un une est que qui dans pour pas sur au aux avec ce cette il elle nous vous ils sont mais ou se ne plus par je tu on son sa ses leur été être avoir fait comme tout très bien merci bonjour',
  de: 'der die das und ist nicht ein eine zu den von mit sich des auf für im dem es ich sie er wir ihr sind auch als an nach wie aus bei war hat noch nur oder aber so kann wenn man schon sehr hier danke guten',
  it: 'il lo la i gli le di che e un una è per non in con si da del della dei sono ma come anche più questo questa ci mi ti io tu lui lei noi voi loro hanno ha ho essere molto grazie ciao buongiorno',
  pt: 'o a os as de que e em um uma é para não com se do da dos das no na por mais mas como ao foi ele ela eu você nós são tem está estou isso este esta muito obrigado olá também já',
  nl: 'de het een en is van in op te dat die niet met voor zijn er maar ook als bij aan om hij zij wij ik je u ze dit wat naar nog wel geen kan dank goedemorgen',
};

const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

// Letras o signos casi exclusivos de un idioma (suman puntos extra)
const MARKS = {
  es: /[ñ¿¡]/g,
  fr: /[çœêèëûîïù]/g,
  de: /[äöüß]/g,
  pt: /[ãõ]/g,
  it: /\b(gli|perché|però|così)\b/g,
};

function guessLatin(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  if (!words.length) return 'en';
  const score = {};
  for (const lang of Object.keys(SETS)) {
    let s = 0;
    for (const w of words) if (SETS[lang].has(w)) s += 1;
    score[lang] = s;
  }
  const lower = text.toLowerCase();
  for (const [lang, re] of Object.entries(MARKS)) score[lang] += 1.5 * ((lower.match(re) || []).length);
  let best = 'en';
  for (const lang of Object.keys(score)) if (score[lang] > score[best]) best = lang;
  return best;
}

function count(text, re) { return (text.match(re) || []).length; }

/** Devuelve un código de idioma (en, es, ja, zh-CN, ko, ru…). */
function guessLanguage(text) {
  const t = String(text || '');
  const kana = count(t, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = count(t, /\p{Script=Han}/gu);
  const scripts = [
    ['ja', kana],
    ['zh-CN', kana ? 0 : han],
    ['ko', count(t, /\p{Script=Hangul}/gu)],
    ['ru', count(t, /\p{Script=Cyrillic}/gu)],
    ['ar', count(t, /\p{Script=Arabic}/gu)],
    ['hi', count(t, /\p{Script=Devanagari}/gu)],
    ['el', count(t, /\p{Script=Greek}/gu)],
    ['he', count(t, /\p{Script=Hebrew}/gu)],
    ['th', count(t, /\p{Script=Thai}/gu)],
  ];
  const latin = count(t, /\p{Script=Latin}/gu);
  const [lang, n] = scripts.sort((a, b) => b[1] - a[1])[0];
  if (n > latin) {
    if (lang === 'ru' && /[іїєґ]/i.test(t)) return 'uk';
    return lang;
  }
  return guessLatin(t);
}

module.exports = { guessLanguage };
