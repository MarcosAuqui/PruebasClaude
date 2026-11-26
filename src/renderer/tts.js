// Lectura en voz alta con la Web Speech API (voces del sistema operativo).
(function () {
  const synth = window.speechSynthesis;
  let voices = [];
  const listeners = [];

  function load() {
    voices = synth ? synth.getVoices() : [];
    listeners.forEach((fn) => fn(voices));
  }
  if (synth) {
    load();
    synth.addEventListener('voiceschanged', load);
  }

  // Prioriza voces neuronales/naturales, luego locales
  function score(v) {
    let s = 0;
    if (/natural|neural|online|premium|enhanced/i.test(v.name)) s += 4;
    if (/google|microsoft/i.test(v.name)) s += 1;
    if (v.localService) s += 1;
    return s;
  }

  function pick(lang, preferredName) {
    if (preferredName) {
      const v = voices.find((x) => x.name === preferredName);
      if (v && v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())) return v;
    }
    const base = lang.toLowerCase();
    const short = base.slice(0, 2);
    const candidates = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base))
      .concat(voices.filter((v) => v.lang.toLowerCase().startsWith(short)));
    return candidates.sort((a, b) => score(b) - score(a))[0] || null;
  }

  window.TTS = {
    available: !!synth,
    voices: () => voices,
    onVoices: (fn) => { listeners.push(fn); fn(voices); },
    speaking: () => !!synth && synth.speaking,
    stop: () => synth && synth.cancel(),
    /** Lee el texto; cancela la lectura anterior para no acumular retraso. */
    speak(text, lang, { voice, rate = 1 } = {}) {
      if (!synth || !text) return false;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pick(lang, voice);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = lang; }
      u.rate = rate;
      synth.speak(u);
      return true;
    },
  };
}());
