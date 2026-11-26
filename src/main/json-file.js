const fs = require('fs');
const path = require('path');

/**
 * Archivo JSON con escritura atómica (tmp + rename) y diferida, para no
 * bloquear ni corromper datos si la app se cierra a mitad de escritura.
 */
class JsonFile {
  constructor(file, { defaults, sanitize, delay = 400 }) {
    this.file = file;
    this.defaults = defaults;
    this.sanitize = sanitize || ((d) => d);
    this.delay = delay;
    this.timer = null;
    this.data = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = this.sanitize(JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Archivo dañado: se aparta para no perderlo y se empieza de cero
        try { fs.renameSync(this.file, `${this.file}.damaged-${Date.now()}`); } catch { /* nada */ }
      }
      this.data = this.sanitize(this.defaults());
    }
    return this.data;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.data == null) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('No se pudo guardar', this.file, err.message);
    }
  }
}

module.exports = { JsonFile };
