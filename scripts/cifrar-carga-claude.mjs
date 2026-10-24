// Cifra un archivo de cambios del CRM (fg-acciones-v1 o fg-historial-polizas-v1) con la llave pública del CRM,
// para subirlo a la rama "cargas-claude" sin que los datos de los clientes queden a la vista en el repositorio público.
// Solo el CRM (con la llave privada guardada en Firebase) puede abrirlo.
//
// Uso:
//   node scripts/cifrar-carga-claude.mjs cambios.json "Título corto" "Resumen (opcional, una línea por cambio)"
//   → crea cargas-claude/AAAA-MM-DD-HHMMSS.json
//
// El título y el resumen van DENTRO del archivo cifrado; el nombre del archivo solo lleva la fecha.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const [rutaCarga, titulo, resumen = ''] = process.argv.slice(2);
if (!rutaCarga || !titulo) { console.error('Uso: node scripts/cifrar-carga-claude.mjs cambios.json "Título" ["Resumen"]'); process.exit(1); }
const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rutaLlave = path.join(raiz, 'cargas-claude', 'llave-publica.pem');
if (!fs.existsSync(rutaLlave)) { console.error('Falta cargas-claude/llave-publica.pem: actívela en el CRM (Cobro de Comisiones › 🤖 Cargas de Claude) y guarde aquí la llave pública.'); process.exit(1); }
const publica = fs.readFileSync(rutaLlave, 'utf8');
const carga = JSON.parse(fs.readFileSync(rutaCarga, 'utf8'));
if (!['fg-acciones-v1', 'fg-historial-polizas-v1'].includes(carga.formato)) { console.error('El archivo debe tener formato fg-acciones-v1 o fg-historial-polizas-v1.'); process.exit(1); }

const claro = Buffer.from(JSON.stringify({ titulo, resumen, preparado: new Date().toISOString(), carga }), 'utf8');
const llaveAes = crypto.randomBytes(32), iv = crypto.randomBytes(12);
const cifrador = crypto.createCipheriv('aes-256-gcm', llaveAes, iv);
// WebCrypto espera el texto cifrado seguido de la etiqueta de autenticación
const datos = Buffer.concat([cifrador.update(claro), cifrador.final(), cifrador.getAuthTag()]);
const llave = crypto.publicEncrypt({ key: publica, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, llaveAes);

const sello = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // AAAAMMDD-HHMMSS
const nombre = `${sello.slice(0, 4)}-${sello.slice(4, 6)}-${sello.slice(6, 8)}-${sello.slice(9)}.json`;
const salida = path.join(raiz, 'cargas-claude', nombre);
fs.writeFileSync(salida, JSON.stringify({ formato: 'fg-carga-cifrada-v1', alg: 'RSA-OAEP-256+A256GCM', llave: llave.toString('base64'), iv: iv.toString('base64'), datos: datos.toString('base64') }) + '\n');
console.log(`Carga cifrada: cargas-claude/${nombre} (${datos.length} bytes)`);
