/*
 * unisci.js                                                  (22 ottobre 2026)
 * Traduzione JavaScript di tools/unisci_img.py (Carica_Mappe): unisce piu' mappe Garmin .img fatte da mkgmap
 * in un solo contenitore .img, senza Java. Stesso risultato byte per byte della versione Python.
 *   Unisci.unisci([Uint8Array, ...], descrizione, data?) -> {parti: [Uint8Array...], byte, tessere}
 *   Unisci.contaTessere(Blob|File) -> Promise<numero|null>
 */
(function (G) {
  "use strict";
  const SETTORE = 512, INIZIO_FAT = 0x400;
  const u16 = (d, o) => d[o] | (d[o + 1] << 8);
  const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 16777216;
  const latin1 = (d) => { let s = ""; for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]); return s; };
  const strip = (s) => s.replace(/^[ \t\n\r\x0b\x0c]+|[ \t\n\r\x0b\x0c]+$/g, "");
  const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i] = c < 256 ? c : 63; } return b; };
  const ljust = (b, n, f) => { const o = new Uint8Array(n).fill(f); o.set(b.subarray(0, n)); return o; };

  function leggiImg(d) {
    if (d[0] !== 0) throw new Error("img cifrato (non fatto da mkgmap)");
    const bs = 1 << (d[0x61] + d[0x62]);
    const parti = new Map();
    let o = INIZIO_FAT;
    while (o + SETTORE <= d.length) {
      const e = d.subarray(o, o + SETTORE);
      o += SETTORE;
      if (e[0] !== 1) {
        if (e[0] === 0 && !e.subarray(1, 12).some(x => x)) {
          if (o > INIZIO_FAT + 64 * 1024) break;
          continue;
        }
        break;
      }
      const nome = latin1(e.subarray(1, 9)), est = latin1(e.subarray(9, 12));
      if (!strip(nome) && !strip(est)) continue;
      const part = u16(e, 0x10);
      const blocchi = [];
      for (let i = 0; i < 240; i++) { const b = u16(e, 0x20 + 2 * i); if (b !== 0xFFFF) blocchi.push(b); }
      const k = nome + "\u0000" + est;
      if (!parti.has(k)) parti.set(k, { nome, est, size: 0, pezzi: [] });
      const v = parti.get(k);
      if (part === 0) v.size = u32(e, 0x0C);
      v.pezzi.push([part, blocchi]);
    }
    const out = [];
    for (const v of parti.values()) {
      v.pezzi.sort((a, b) => a[0] - b[0] || cmpLista(a[1], b[1]));
      const dati = new Uint8Array(v.size);
      let p = 0;
      for (const [, bl] of v.pezzi) for (const b of bl) {
        if (p >= v.size) break;
        const pezzo = d.subarray(b * bs, Math.min((b + 1) * bs, d.length)).subarray(0, v.size - p);
        dati.set(pezzo, p); p += pezzo.length;
      }
      out.push({ nome: v.nome, est: v.est, dati: p === v.size ? dati : dati.subarray(0, p) });
    }
    return { parti: out, testa: d.subarray(0, SETTORE) };
  }
  function cmpLista(a, b) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }

  const fidTyp = (d) => d.length >= 0x31 ? u16(d, 0x2F) : 0;

  function geometria(settori) {
    for (const [s, h] of [[4, 16], [8, 16], [16, 16], [32, 16], [32, 32], [32, 64], [32, 128], [32, 255], [63, 255]])
      if (Math.floor((settori - 1) / (s * h)) <= 1023) return [s, h];
    return [63, 255];
  }
  const ceil = (a, b) => Math.ceil(a / b);

  function scriviImg(sottoparti, descrizione, testaModello, data) {
    let e2 = 0, bs, nb, riservato;
    for (;;) {
      bs = SETTORE << e2;
      nb = sottoparti.map(x => Math.max(1, ceil(x.dati.length, bs)));
      const voci = nb.reduce((a, n) => a + ceil(n, 240), 0);
      riservato = INIZIO_FAT + (voci + 1) * SETTORE;
      const blocchi = ceil(riservato, bs) + nb.reduce((a, n) => a + n, 0);
      if (blocchi < 0xFFF0 && ceil(riservato, bs) <= 240) break;
      e2++;
    }
    const blocchiRis = ceil(riservato, bs);
    const fat = [], dati = [];
    let prossimo = blocchiRis;
    function voce(nome, est, size, part, bl) {
      const v = new Uint8Array(SETTORE), dv = new DataView(v.buffer);
      v[0] = 1;
      v.set(ljust(enc(nome).subarray(0, 8), 8, 32), 1);
      v.set(ljust(enc(est).subarray(0, 3), 3, 32), 9);
      dv.setUint32(0x0C, size, true);
      dv.setUint16(0x10, part, true);
      for (let i = 0; i < 240; i++) dv.setUint16(0x20 + 2 * i, i < bl.length ? bl[i] : 0xFFFF, true);
      return v;
    }
    const prime = []; for (let i = 0; i < Math.min(blocchiRis, 240); i++) prime.push(i);
    fat.push(voce("        ", "   ", blocchiRis * bs, 3, prime));
    sottoparti.forEach((x, j) => {
      const n = nb[j], bl = [];
      for (let i = 0; i < n; i++) bl.push(prossimo + i);
      prossimo += n;
      for (let i = 0; i < Math.max(1, bl.length); i += 240)
        fat.push(voce(x.nome, x.est, i === 0 ? x.dati.length : 0, i ? Math.floor(i / 240) * 256 : 0, bl.slice(i, i + 240)));
      dati.push(x.dati);
      const resto = n * bs - x.dati.length;
      if (resto) dati.push(new Uint8Array(resto));
    });
    const tot = prossimo * bs, settori = tot / SETTORE;
    const [s, h] = geometria(settori);
    const head = ljust(testaModello.subarray(0, SETTORE), SETTORE, 0), hv = new DataView(head.buffer);
    head[0] = 0;
    const t = data || new Date();
    head[0x0A] = t.getMonth() + 1; head[0x0B] = (t.getFullYear() - 1900) & 0xFF;
    head.set(enc("DSKIMG\u0000"), 0x10);
    hv.setUint16(0x18, s, true); hv.setUint16(0x1A, h, true); hv.setUint16(0x1C, 0, true);
    hv.setUint16(0x39, t.getFullYear(), true);
    head[0x3B] = t.getMonth() + 1; head[0x3C] = t.getDate(); head[0x3D] = t.getHours(); head[0x3E] = t.getMinutes(); head[0x3F] = t.getSeconds();
    head[0x40] = INIZIO_FAT / SETTORE;
    head.set(enc("GARMIN\u0000"), 0x41);
    const desc = ljust(enc(descrizione).subarray(0, 50), 50, 32);
    head.set(desc.subarray(0, 20), 0x49);
    hv.setUint16(0x5D, h, true); hv.setUint16(0x5F, s, true); head[0x61] = 9; head[0x62] = e2;
    hv.setUint16(0x63, Math.min(prossimo + 1, 0xFFFF), true);
    head.set(desc.subarray(20, 50), 0x65);
    const ult = settori - 1, cil = Math.floor(ult / (s * h)), r = ult % (s * h), testa = Math.floor(r / s), sett = r % s;
    const p = new Uint8Array(16), pv = new DataView(p.buffer);
    p[2] = 1; p[5] = testa; p[6] = ((sett + 1) & 0x3F) | ((cil >> 2) & 0xC0); p[7] = cil & 0xFF;
    pv.setUint32(8, 0, true); pv.setUint32(12, settori, true);
    head.set(p, 0x1BE); head[0x1FE] = 0x55; head[0x1FF] = 0xAA;
    const fatTot = new Uint8Array(fat.length * SETTORE); fat.forEach((v, i) => fatTot.set(v, i * SETTORE));
    const parti = [head, new Uint8Array(INIZIO_FAT - SETTORE), fatTot,
                   new Uint8Array(blocchiRis * bs - INIZIO_FAT - fat.length * SETTORE)].concat(dati);
    return { parti, byte: tot };
  }

  function unisci(fileImg, descrizione, data) {
    const sottoparti = [], mps = [], visti = new Set();
    let modello = null, tessere = 0;
    for (const d of fileImg) {
      const { parti, testa } = leggiImg(d);
      modello = modello || testa;
      for (const x of parti) {
        let nome = x.nome;
        if (x.est === "MPS") { mps.push(x.dati); continue; }
        if (x.est === "TYP") nome = "T" + String(fidTyp(x.dati)).padStart(7, "0");
        const k = nome + "\u0000" + x.est;
        if (visti.has(k)) continue;
        visti.add(k);
        if (x.est === "TRE") tessere++;
        sottoparti.push({ nome, est: x.est, dati: x.dati });
      }
    }
    const lt = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    sottoparti.sort((a, b) => ((a.est !== "TYP") - (b.est !== "TYP")) || lt(a.nome, b.nome) || lt(a.est, b.est));
    let n = 0; mps.forEach(m => n += m.length);
    const tutto = new Uint8Array(n); n = 0; mps.forEach(m => { tutto.set(m, n); n += m.length; });
    sottoparti.unshift({ nome: "MAKEGMAP", est: "MPS", dati: tutto });
    const r = scriviImg(sottoparti, descrizione, modello, data);
    r.tessere = tessere;
    return r;
  }

  async function contaTessere(blob) {
    try {
      let h = new Uint8Array(await blob.slice(0, 0x600).arrayBuffer());
      const k = h[0];
      if (k) h = h.map(b => b ^ k);
      const bs = 1 << (h[0x61] + h[0x62]);
      const lun = Math.min(Math.max(bs * 240, 1 << 20), 8 << 20);
      let fat = new Uint8Array(await blob.slice(INIZIO_FAT, INIZIO_FAT + lun).arrayBuffer());
      if (k) fat = fat.map(b => b ^ k);
      let n = 0;
      for (let i = 0; i + SETTORE <= fat.length; i += SETTORE) {
        const e = fat.subarray(i, i + SETTORE);
        if (e[0] !== 1) { if (e.subarray(0, 12).some(x => x)) break; continue; }
        if (e[9] === 84 && e[10] === 82 && e[11] === 69 && u16(e, 0x10) === 0) n++;
      }
      return n;
    } catch (err) { return null; }
  }

  G.Unisci = { leggiImg, scriviImg, unisci, contaTessere, fidTyp };
})(typeof window !== "undefined" ? window : globalThis);
