// Sube a Firebase (colección crm_cargas_claude) las cargas cifradas de la carpeta cargas-claude/ que aún no estén allí.
// Lo ejecuta la GitHub Action "Cargas de Claude" con el usuario exclusivo de Claude, que según las reglas de Firestore
// solo puede CREAR documentos en esa colección: no puede leer, cambiar ni borrar nada del CRM.
// Las cargas quedan "pendientes" hasta que el administrador las aplica desde el CRM (Cobro de Comisiones › 🤖 Cargas de Claude).
//
// El registro de la Action es público (el repositorio es público): aquí solo se imprimen nombres de archivo, nunca datos.
//
// Variables de entorno (secretos del repositorio en GitHub):
//   CRM_BOT_EMAIL, CRM_BOT_PASSWORD   usuario de Claude en Firebase Authentication
//
// Uso:
//   node scripts/subir-cargas-claude.mjs cargas-claude/2026-10-24-180000.json …   → sube esas (las que trajo el push)
//   node scripts/subir-cargas-claude.mjs                                           → intenta todas las de la carpeta

import fs from 'node:fs';
import path from 'node:path';

const FIREBASE_API_KEY = 'AIzaSyADrF8yx_O0fIolJl2zutFtgi5VbyPv52c'; // la misma clave pública que usa index.html
const FIREBASE_PROJECT = 'crm-fg-21ec0';
const CARPETA = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'cargas-claude');

async function iniciarSesion() {
  // los secretos pegados a mano suelen traer espacios o saltos de línea al inicio o al final
  const email = (process.env.CRM_BOT_EMAIL || '').trim(), password = (process.env.CRM_BOT_PASSWORD || '').trim();
  if (!email || !password) throw new Error('Faltan los secretos CRM_BOT_EMAIL y CRM_BOT_PASSWORD.');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('No se pudo iniciar sesión con el usuario de Claude: ' + (j.error && j.error.message));
  return j.idToken;
}

const texto = v => ({ stringValue: String(v) });

async function main() {
  const pedidos = process.argv.slice(2).map(f => path.basename(f));
  const todas = !pedidos.length;
  const archivos = (todas ? (fs.existsSync(CARPETA) ? fs.readdirSync(CARPETA) : []) : pedidos).filter(f => /^\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(f)).sort();
  if (!archivos.length) { console.log('No hay cargas en cargas-claude/.'); return; }
  const token = await iniciarSesion();
  let nuevas = 0, yaEstaban = 0;
  for (const archivo of archivos) {
    const c = JSON.parse(fs.readFileSync(path.join(CARPETA, archivo), 'utf8'));
    if (c.formato !== 'fg-carga-cifrada-v1' || !c.llave || !c.iv || !c.datos) throw new Error(`${archivo} no es una carga cifrada (¿se subió sin cifrar?).`);
    const id = archivo.replace(/\.json$/, '');
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/crm_cargas_claude?documentId=${id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        archivo: texto(archivo), estado: texto('pendiente'), creado: texto(new Date().toISOString()),
        cifrado: { mapValue: { fields: { formato: texto(c.formato), alg: texto(c.alg || ''), llave: texto(c.llave), iv: texto(c.iv), datos: texto(c.datos) } } },
      } }),
    });
    // Ya subida antes: Firebase responde 409, o 403 porque las reglas no dejan al usuario de Claude tocar una carga existente.
    // Si era una carga nueva, un 403 significa que las reglas de Firestore no están publicadas.
    if (r.status === 409 || (r.status === 403 && todas)) { yaEstaban++; console.log(`${archivo}: ya estaba en el CRM (se deja como está)`); continue; }
    if (r.status === 403) throw new Error(`Firebase no dejó subir ${archivo} (403). Revise que las reglas de Firestore con crm_cargas_claude estén publicadas.`);
    if (!r.ok) throw new Error(`No se pudo subir ${archivo}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    nuevas++; console.log(`${archivo}: subida, pendiente de aprobación en el CRM`);
  }
  console.log(`Listo: ${nuevas} carga(s) nueva(s), ${yaEstaban} ya estaban.`);
}

// ::error:: deja el motivo como anotación de la Action (se ve sin abrir el registro); nunca lleva datos de clientes
main().catch(e => { console.error(e.message); if (process.env.GITHUB_ACTIONS) console.log(`::error::${e.message}`); process.exit(1); });
