/*
 * lavoro.js – Estrazione Mappe web                           (23 ottobre 2026)
 * Gira in un Web Worker: carica Python (Pyodide) con ezdxf e pyproj, legge dal Drive (chiave API) il programma
 * Estrarre_Mappe (Estrazione_mappe/Programma/estrarre_mappe.py e gis_lavoro.py) e gli elenchi _dati, e fa
 * l'estrazione con LO STESSO codice dell'app per Mac/Windows. I file prodotti tornano alla pagina.
 * 29 ott: anche terreno.py; con le caselle "3d" / "terreno" scarica le tessere DTM della zona (DTM_TESSERE).
 * Messaggi dalla pagina: avvio, vicini, rettangolo, prepara, estrai.  Alla pagina: pronto, log, avanza, risposta, errore.
 */
"use strict";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const EZDXF = "ezdxf==1.4.5";
const FONT = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf";
const API = "https://www.googleapis.com/drive/v3/files";
importScripts(PYODIDE + "pyodide.js");

let py = null, CHIAVE = "", RADICE = "";
const elenchi = new Map();
const manda = (t, d) => postMessage(Object.assign({ t }, d || {}));
const log = (s) => manda("log", { s: String(s) });

// ---------------------------------------------------------------- Drive (come Carica Mappe 1.4)
async function driveGet(url, tentativi = 3) {
  let r = null, ultimo = null;
  for (let i = 0; i < tentativi; i++) {
    try {
      r = await fetch(url, { cache: "no-store" });
      if (r.ok || (r.status !== 429 && r.status < 500)) break;
      ultimo = new Error("Drive: " + r.status);
    } catch (e) { ultimo = e; r = null; }
    if (i < tentativi - 1) await new Promise(ok => setTimeout(ok, 1500 * (i + 1)));
  }
  if (!r) throw new Error("Google Drive non risponde (" + (ultimo ? ultimo.message : "rete") + "). Riprova fra qualche minuto.");
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch (e) {} throw new Error("Drive: " + r.status + (m ? " " + m : "")); }
  return r;
}
async function elenco(id) {
  if (elenchi.has(id)) return elenchi.get(id);
  const out = new Map(); let tok = "";
  do {
    const q = new URLSearchParams({ q: "'" + id + "' in parents and trashed=false", pageSize: "1000", key: CHIAVE,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (tok) q.set("pageToken", tok);
    const d = await (await driveGet(API + "?" + q)).json();
    for (const f of d.files || []) { const n = f.name.normalize("NFC"); if (!out.has(n)) out.set(n, f); }
    tok = d.nextPageToken || "";
  } while (tok);
  elenchi.set(id, out);
  return out;
}
async function trova(parti) {
  let id = RADICE, f = null;
  for (const p of parti) {
    const el = await elenco(id);
    f = el.get(p.normalize("NFC"));
    if (!f) throw new Error("sul Drive non trovo " + parti.join("/"));
    id = f.id;
  }
  return f;
}
async function contenuto(f) {
  let errore = null;
  for (const u of ["https://www.googleapis.com/download/drive/v3/files/" + f.id + "?alt=media&key=" + CHIAVE,
                   API + "/" + f.id + "?alt=media&key=" + CHIAVE]) {
    try { return new Uint8Array(await (await driveGet(u)).arrayBuffer()); } catch (e) { errore = e; }
  }
  throw errore;
}
async function scarica(f) {                 // con la cache del browser: la seconda volta la tavola non si riscarica
  const chiave = "https://cache.estrazione/" + f.id + "/" + encodeURIComponent(f.modifiedTime || "");
  let cache = null;
  try { cache = await caches.open("estrazione-mappe"); const c = await cache.match(chiave); if (c) return [new Uint8Array(await c.arrayBuffer()), true]; } catch (e) { cache = null; }
  const d = await contenuto(f);
  if (cache) { try { await cache.put(chiave, new Response(d)); } catch (e) {} }
  return [d, false];
}

// ---------------------------------------------------------------- file system di Python
function scrivi(p, bytes) { py.FS.mkdirTree(p.split("/").slice(0, -1).join("/")); py.FS.writeFile(p, bytes); }
function esiste(p) { try { py.FS.stat(p); return true; } catch (e) { return false; } }
function cancellaAlbero(p) {
  if (!esiste(p)) return;
  for (const n of py.FS.readdir(p)) {
    if (n === "." || n === "..") continue;
    const q = p + "/" + n;
    if (py.FS.isDir(py.FS.stat(q).mode)) cancellaAlbero(q); else py.FS.unlink(q);
  }
  py.FS.rmdir(p);
}
function fileIn(p, base) {                  // [{rel, dati}] di tutta la cartella
  const out = [];
  for (const n of py.FS.readdir(p)) {
    if (n === "." || n === "..") continue;
    const q = p + "/" + n, r = (base ? base + "/" : "") + n;
    if (py.FS.isDir(py.FS.stat(q).mode)) out.push(...fileIn(q, r)); else out.push({ rel: r, dati: py.FS.readFile(q) });
  }
  return out;
}
const pyJson = (codice) => JSON.parse(py.runPython(codice));

// ---------------------------------------------------------------- comandi
async function avvio(m) {
  CHIAVE = m.chiave; RADICE = m.radice;
  manda("stato", { s: "Carico Python nel browser (la prima volta circa 30 MB)…" });
  py = await loadPyodide({ indexURL: PYODIDE });
  py.setStdout({ batched: log }); py.setStderr({ batched: log });
  await py.loadPackage(["numpy", "pyproj", "sqlite3", "micropip"]);
  manda("stato", { s: "Carico ezdxf…" });
  await py.runPythonAsync("import micropip\nawait micropip.install('" + EZDXF + "')");
  // ezdxf misura le scritte con un carattere TrueType: nel browser non ce ne sono ("no default font found").
  // Gli si da' DejaVu Sans, che e' proprio il suo carattere di riserva.
  try {
    const r = await fetch(FONT);
    if (r.ok) {
      scrivi("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", new Uint8Array(await r.arrayBuffer()));
      py.runPython("from ezdxf.fonts import fonts as _f\n_f.font_manager.clear()\n_f.font_manager.build(['/usr/share/fonts'])");
    }
  } catch (e) { log("(carattere DejaVu non caricato: le scritte si misurano in modo approssimato)"); }
  manda("stato", { s: "Leggo il programma e gli elenchi dal Drive…" });
  const prog = await elenco((await trova(["Estrazione_mappe", "Programma"])).id);
  for (const n of ["estrarre_mappe.py", "gis_lavoro.py", "terreno.py"]) {
    const f = prog.get(n);
    if (!f) { if (n === "terreno.py") continue; throw new Error("sul Drive manca Programma/" + n); }
    scrivi("/prog/" + n, await contenuto(f));
  }
  const dati = await elenco((await trova(["Estrazione_mappe", "_dati"])).id);
  let quando = "";
  for (const f of dati.values()) {
    if (/^indice_|prima_|\.bak$/.test(f.name) || f.mimeType === "application/vnd.google-apps.folder") continue;
    scrivi("/dati/_dati/" + f.name, await contenuto(f));
    if (f.name === "regioni.csv" || /elementi\.csv$/.test(f.name)) quando = f.modifiedTime > quando ? f.modifiedTime : quando;
  }
  const info = pyJson(`
import os, sys, json
os.environ.setdefault("LIMITE_FILE_MB", "150")      # nel browser la memoria e' poca: oltre 150 MB ritagliati, un DXF per comune
sys.path.insert(0, "/prog")
import estrarre_mappe as E
arch = E.Archivio("/dati")
json.dumps({"versione": E.VERSIONE,
            "regioni": [[k, arch.reg[k]["nome"]] for k in arch.regioni()],
            "comuni": sorted([list(k) for k in arch.elementi]),
            "uscite": E.USCITE_NOMI, "spente": list(getattr(E, "USCITE_SPENTE", ()))})
`);
  info.dati = quando;
  manda("pronto", info);
}

function vicini(m) {
  py.globals.set("_a", py.toPy([m.reg, m.prov, m.com]));
  return pyJson(`json.dumps([list(k) for k in arch.confinanti(*_a)])`);
}
function rettangolo(m) {
  py.globals.set("_a", py.toPy([m.reg, m.prov, m.com, m.km]));
  return pyJson(`
_r, _l = E.rettangolo_comune(arch, _a[0], _a[1], _a[2], tuple(_a[3]))
json.dumps({"r": _r, "comuni": [list(k) for k in _l]})`);
}
function elementiZip(m) {                   // gli zip che servono, come in estrai() (TM33 se le regioni sono miste)
  py.globals.set("_a", py.toPy([m.reg, m.prov, m.com, m.aggiunti]));
  return pyJson(`
_reg, _prov, _com, _agg = _a[0], _a[1], _a[2], [tuple(x) for x in _a[3]]
_el = arch.lista_elementi(_reg, _prov, _com, _agg)
_s0 = arch.sistema(_reg)
_misto = any(":" in e and arch.sistema(e.split(":")[0]) != _s0 for e in _el)
_rel = []
for e in _el:
    r, c = (e.split(":", 1) if ":" in e else (_reg, e))
    i = arch.reg[r]
    cart, nome = ((i["cartella33"], i["zip33"]) if _misto else (i["cartella"], i["zip"]))
    if cart and nome:
        _rel.append(cart + "/" + nome.replace("@@@", c))
json.dumps({"rel": _rel, "elementi": len(_el), "fuso": 33 if _misto else _s0})`);
}
async function tessereTerreno(m) {          // 29 ott: tessere DTM della zona, come terreno.prepara() nell'app
  const u = m.uscite || [], serie = [];
  if (u.includes("3d")) serie.push("WGS84");
  if (u.includes("terreno")) serie.push("UTM32");
  if (!serie.length) return [];
  for (const s of serie) {
    const p = "/dati/DTM_TESSERE/indice_" + s + ".csv";
    if (!esiste(p)) {
      try { scrivi(p, await contenuto(await trova(["Estrazione_mappe", "DTM_TESSERE", "indice_" + s + ".csv"]))); }
      catch (e) { log("Terreno " + s + ": indice non trovato sul Drive"); }
    }
  }
  py.globals.set("_t", py.toPy([m.reg, m.prov, m.com, m.aggiunti, m.rett || null, serie]));
  return pyJson(`
import terreno as T
_reg, _prov, _com, _agg, _rt, _ser = _t[0], _t[1], _t[2], [tuple(x) for x in _t[3]], _t[4], list(_t[5])
_box = None
if _rt:
    _r, _ = E.rettangolo_comune(arch, _reg, _prov, _com, tuple(_rt))
    _box = tuple(_r) if _r else None
if _box is None:
    _d = E.riquadri_gradi(arch)
    _bb = [_d[k] for k in [(_reg, _prov, _com)] + _agg if k in _d]
    if _bb:
        _box = (min(b[0] for b in _bb), min(b[1] for b in _bb), max(b[2] for b in _bb), max(b[3] for b in _bb))
_out = []
if _box:
    for _s in _ser:
        _p = "/dati/DTM_TESSERE/indice_%s.csv" % _s
        if not os.path.isfile(_p):
            continue
        _b = _box if _s == "WGS84" else T.box_utm32(_box)
        _m = T.SERIE[_s]["margine"]
        _out += ["DTM_TESSERE/%s/%s.tif" % (_s, t[0]) for t in T.scegli(T.leggi_indice(_p), (_b[0] - _m, _b[1] - _m, _b[2] + _m, _b[3] + _m))]
json.dumps(_out)`);
}
async function prepara(m) {
  const z = elementiZip(m);
  let byte = 0, mancano = 0, inCache = 0;
  try { z.rel = z.rel.concat(await tessereTerreno(m)); } catch (e) { log("Terreno: " + e.message); }
  for (const r of z.rel) {
    try { const f = await trova(["Estrazione_mappe"].concat(r.split("/"))); byte += +f.size || 0; } catch (e) { mancano++; }
  }
  return { tavole: z.rel.length, elementi: z.elementi, byte, mancano, fuso: z.fuso };
}

async function estrai(m) {
  const t0 = Date.now();
  const z = elementiZip(m);
  let fatto = 0, tot = 0;
  const ff = [];
  for (const r of z.rel) { try { const f = await trova(["Estrazione_mappe"].concat(r.split("/"))); ff.push([r, f]); tot += +f.size || 0; } catch (e) { log("  " + r.split("/").pop() + ": non c'e' sul Drive"); } }
  const nDxf = ff.length; let tTer = 0;
  let tt = [];
  try { tt = await tessereTerreno(m); } catch (e) { log("Terreno: " + e.message); }
  for (const r of tt) { try { const f = await trova(["Estrazione_mappe"].concat(r.split("/"))); ff.push([r, f]); tot += +f.size || 0; tTer += +f.size || 0; } catch (e) { log("  " + r.split("/").pop() + ": non c'e' sul Drive"); } }
  log("Scarico " + nDxf + " file DXF" + (ff.length > nDxf ? " e " + (ff.length - nDxf) + " tessere del terreno (" + Math.round(tTer / 1048576) + " MB)" : "") +
      " dal Drive (" + Math.round(tot / 1048576) + " MB in tutto)…");
  for (const [r, f] of ff) {
    const p = "/dati/" + r;
    if (!esiste(p)) {
      const [d, c] = await scarica(f);
      scrivi(p, d);
      if (!c) log("  scaricato " + f.name + " (" + (d.length / 1048576).toFixed(1) + " MB)");
    }
    fatto += +f.size || 0;
    manda("avanza", { parte: "scarico", fatto, tot });
  }
  manda("avanza", { parte: "elaboro" });
  const lavoro = "/lavoro/" + t0;
  py.globals.set("_a", py.toPy([m.reg, m.prov, m.com, m.aggiunti, m.uscite, m.rett || null, lavoro]));
  py.globals.set("_log", log);
  const dest = await py.runPythonAsync(`
_reg, _prov, _com, _agg, _usc, _rt, _lav = _a[0], _a[1], _a[2], [tuple(x) for x in _a[3]], list(_a[4]), _a[5], _a[6]
_rettangolo = None
if _rt:
    _r, _ = E.rettangolo_comune(arch, _reg, _prov, _com, tuple(_rt))
    if _r:
        _rettangolo = tuple(_r) + ("N%g S%g E%g O%g" % tuple(_rt),)
E.estrai(arch, _reg, _prov, _com, _agg, [], _lav, _log, uscite=_usc, rettangolo=_rettangolo)
`);
  const nome = String(dest).split("/").pop();
  const files = fileIn(String(dest), "");
  const byte = files.reduce((a, f) => a + f.dati.length, 0);
  // zip per i browser che non scrivono in una cartella: lo fa Python (zipfile), con dentro la cartella <nome>
  let zip = null;
  if (m.comeZip) {
    py.globals.set("_d", String(dest));
    const pz = py.runPython(`
import zipfile, os
_z = "/lavoro/" + os.path.basename(_d) + ".zip"
with zipfile.ZipFile(_z, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for b, _dd, fs in os.walk(_d):
        for n in fs:
            p = os.path.join(b, n)
            zf.write(p, os.path.join(os.path.basename(_d), os.path.relpath(p, _d)))
_z`);
    zip = py.FS.readFile(pz);
    py.FS.unlink(pz);
  }
  cancellaAlbero(lavoro);
  for (const [r] of ff) { try { py.FS.unlink("/dati/" + r); } catch (e) {} }   // restano nella cache del browser
  const secondi = Math.round((Date.now() - t0) / 1000);
  if (zip) { postMessage({ t: "risposta", id: m.id, v: { nome, byte, n: files.length, secondi, zip } }, [zip.buffer]); return null; }
  postMessage({ t: "risposta", id: m.id, v: { nome, byte, n: files.length, secondi, files } }, files.map(f => f.dati.buffer));
  return null;
}

onmessage = async (e) => {
  const m = e.data;
  try {
    let v;
    if (m.t === "avvio") return await avvio(m);
    if (m.t === "vicini") v = vicini(m);
    else if (m.t === "rettangolo") v = rettangolo(m);
    else if (m.t === "prepara") v = await prepara(m);
    else if (m.t === "estrai") { await estrai(m); return; }
    else if (m.t === "svuota") { try { await caches.delete("estrazione-mappe"); } catch (x) {} v = true; }
    manda("risposta", { id: m.id, v });
  } catch (err) {
    manda("errore", { id: m.id, s: (err && err.message) ? err.message : String(err) });
  }
};
