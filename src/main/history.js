const fs = require('fs/promises');
const { JsonFile } = require('./json-file');

const MAX = 2000;

class History {
  constructor(file) {
    this.store = new JsonFile(file, {
      defaults: () => [],
      sanitize: (d) => (Array.isArray(d) ? d.filter((e) => e && e.translated).slice(-MAX) : []),
      delay: 1500,
    });
    this.items = this.store.load();
  }

  /** Añade una entrada; ignora repeticiones consecutivas del mismo recuadro. */
  add(entry) {
    for (let i = this.items.length - 1; i >= 0 && i >= this.items.length - 8; i--) {
      const e = this.items[i];
      if (e.boxId === entry.boxId) {
        if (e.original === entry.original && e.target === entry.target) return null;
        break;
      }
    }
    const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...entry };
    this.items.push(item);
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
    this.store.data = this.items;
    this.store.save();
    return item;
  }

  list() { return this.items; }

  clear() {
    this.items = [];
    this.store.data = this.items;
    this.store.flush();
  }

  flush() { this.store.flush(); }

  async export(filePath, format) {
    await fs.writeFile(filePath, History.format(this.items, format), 'utf8');
    return this.items.length;
  }

  static format(items, format) {
    const time = (ts) => new Date(ts).toLocaleString();
    switch (format) {
      case 'json':
        return JSON.stringify(items, null, 2);
      case 'csv': {
        const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [['fecha', 'recuadro', 'origen', 'destino', 'original', 'traduccion'].join(',')];
        for (const e of items) {
          rows.push([time(e.ts), e.boxName, e.detected, e.target, e.original, e.translated].map(q).join(','));
        }
        return `﻿${rows.join('\r\n')}`; // BOM para que Excel respete los acentos
      }
      case 'srt': {
        if (!items.length) return '';
        const t0 = items[0].ts;
        const fmt = (ms) => {
          const h = Math.floor(ms / 3600000);
          const m = Math.floor((ms % 3600000) / 60000);
          const s = Math.floor((ms % 60000) / 1000);
          const r = ms % 1000;
          const p = (n, l = 2) => String(n).padStart(l, '0');
          return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
        };
        return items.map((e, i) => {
          const start = e.ts - t0;
          const next = items[i + 1] ? items[i + 1].ts - t0 : start + 3000;
          const end = Math.max(start + 500, Math.min(next, start + 7000));
          return `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${e.translated}\n`;
        }).join('\n');
      }
      default:
        return items.map((e) => (
          `[${time(e.ts)}] Recuadro ${e.boxName} · ${e.detected || '?'} → ${e.target}\n`
          + `${e.original}\n→ ${e.translated}\n`
        )).join('\n');
    }
  }
}

module.exports = { History };
