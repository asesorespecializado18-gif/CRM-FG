// Alertas diarias de FG Pólizas: lee el CRM en Firebase y envía por correo
// lo que vence hoy, mañana y en los próximos 7 días.
//
// Uso:
//   node scripts/alertas-diarias.mjs                       → lee Firebase y envía el correo
//   node scripts/alertas-diarias.mjs --prueba              → lee Firebase y solo guarda el correo en alertas.html
//   node scripts/alertas-diarias.mjs --respaldo r.json     → usa un respaldo del CRM en vez de Firebase (implica --prueba)
//
// Variables de entorno (secretos del repositorio en GitHub):
//   FG_EMAIL, FG_PASSWORD        usuario administrador del CRM (para leer Firebase)
//   SMTP_USER, SMTP_PASSWORD     cuenta de Gmail que envía y su contraseña de aplicación
//   ALERTAS_PARA                 destinatario(s), separados por coma (por defecto eflores@altacorredores.com)
//   FECHA_HOY                    opcional, AAAA-MM-DD, para simular otro día

import fs from 'node:fs';

const FIREBASE_API_KEY = 'AIzaSyADrF8yx_O0fIolJl2zutFtgi5VbyPv52c'; // la misma clave pública que usa index.html
const FIREBASE_PROJECT = 'crm-fg-21ec0';
const DESTINO_DEFECTO = 'eflores@altacorredores.com';

const args = process.argv.slice(2);
const rutaRespaldo = args.includes('--respaldo') ? args[args.indexOf('--respaldo') + 1] : null;
const soloPrueba = args.includes('--prueba') || !!rutaRespaldo;

// ---------------- fechas (hora de Lima) ----------------
const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const HOY = process.env.FECHA_HOY || hoyLima();
const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasHasta = iso => Math.round((new Date(iso.slice(0, 10) + 'T00:00:00Z') - new Date(HOY + 'T00:00:00Z')) / 86400000);
const fmtDate = d => { if (!d) return '—'; const [y, m, day] = d.slice(0, 10).split('-'); return `${day}/${m}/${y}`; };

// ---------------- lectura de Firebase ----------------
async function iniciarSesion() {
  const { FG_EMAIL, FG_PASSWORD } = process.env;
  if (!FG_EMAIL || !FG_PASSWORD) throw new Error('Faltan FG_EMAIL y FG_PASSWORD para leer el CRM.');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: FG_EMAIL, password: FG_PASSWORD, returnSecureToken: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('No se pudo iniciar sesión en el CRM: ' + (j.error && j.error.message));
  return j.idToken;
}

// Convierte un valor tipado de la API REST de Firestore a JSON normal
function valor(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  if ('mapValue' in v) return campos(v.mapValue.fields);
  return null;
}
const campos = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, valor(v)]));

async function leerFirestore(token, ruta) {
  const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${ruta}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (ruta.includes('/')) {
    const r = await fetch(base, { headers });
    if (!r.ok) throw new Error(`No se pudo leer ${ruta}: ${r.status}`);
    return campos((await r.json()).fields);
  }
  const docs = [];
  let pageToken = '';
  do {
    const r = await fetch(`${base}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, { headers });
    if (!r.ok) throw new Error(`No se pudo leer ${ruta}: ${r.status}`);
    const j = await r.json();
    (j.documents || []).forEach(d => docs.push(campos(d.fields)));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function cargarDatos() {
  if (rutaRespaldo) {
    const d = JSON.parse(fs.readFileSync(rutaRespaldo, 'utf8'));
    return { clientes: d.clientes || [], ventas: d.ventas || [], seguimientos: d.seguimientos || [], productosPersonalizados: d.productosPersonalizados || [] };
  }
  const token = await iniciarSesion();
  const main = await leerFirestore(token, 'crm/main');
  const core = main.core || {};
  const [clientes, ventas] = await Promise.all([leerFirestore(token, 'crm_clientes'), leerFirestore(token, 'crm_ventas')]);
  return { clientes, ventas, seguimientos: core.seguimientos || [], productosPersonalizados: core.productosPersonalizados || [] };
}

// ---------------- reglas (las mismas del CRM) ----------------
const PRODUCTOS = {
  seguros_vehiculares: 'Seguros Vehiculares', soat: 'SOAT', sctr_pension: 'SCTR Pensión', sctr_salud: 'SCTR Salud',
  vida_ley: 'Vida Ley', salud: 'Salud', eps: 'EPS', seguro_domicilio: 'Seguro de Domicilio', trec: 'TREC', car: 'CAR',
  desgravamen: 'Desgravamen', responsabilidad_civil: 'Responsabilidad Civil', multiriesgo: 'Multiriesgo',
  cartas_fianza: 'Cartas Fianza', cauciones: 'Cauciones', seguro_carga: 'Seguro de Carga', seguro_transporte: 'Seguro de Transporte',
  seguro_oncologico: 'Seguro Oncológico', seguro_oncologico_plus: 'Seguro Oncológico Plus',
};
const NO_SEGURO = new Set(['asesoria_contable', 'asesoria_cartas_fianza', 'consultoria_general']);

function calcularAlertas(datos) {
  const personalizados = Object.fromEntries((datos.productosPersonalizados || []).map(p => [p.id, p]));
  const prodLabel = id => PRODUCTOS[id] || (personalizados[id] && personalizados[id].label) || id || '—';
  const esSeguro = id => !NO_SEGURO.has(id) && (!personalizados[id] || personalizados[id].categoria !== 'servicio');
  const clientePorId = Object.fromEntries(datos.clientes.map(c => [c.id, c]));
  const activas = datos.ventas.filter(v => v.estadoVenta !== 'anulada');
  const seguros = activas.filter(v => esSeguro(v.tipoProducto));
  const familia = t => /^sctr/.test(t || '') ? 'sctr' : t;
  const yaRenovada = v => activas.some(v2 => v2.id !== v.id && v2.clienteId === v.clienteId && familia(v2.tipoProducto) === familia(v.tipoProducto)
    && (v2.fechaVenta || '') >= addDaysISO(v.vigenciaFin, -120)
    && (() => { const ini = v2.vigenciaInicio || v2.fechaVenta || ''; return ini >= addDaysISO(v.vigenciaFin, -60) && ini <= addDaysISO(v.vigenciaFin, 60); })());

  const fila = (v, extra = {}) => {
    const c = clientePorId[v.clienteId] || {};
    return {
      cliente: c.nombre || '—', celular: c.celular1 || c.telefono || '', poliza: v.numeroPoliza || (v.folio ? 'V-' + String(v.folio).padStart(4, '0') : '—'),
      producto: prodLabel(v.tipoProducto), aseguradora: v.aseguradora || '',
      detalle: [v.vehMarca, v.vehModelo, v.vehPlaca].filter(Boolean).join(' '), ...extra,
    };
  };

  // Pólizas que vencen (sin las ya renovadas ni las marcadas "no renueva")
  const polizas = seguros.filter(v => v.vigenciaFin && !['renovado', 'no_renueva'].includes((v.renov || {}).estado))
    .map(v => ({ v, dias: diasHasta(v.vigenciaFin) }))
    .filter(x => x.dias >= 0 && x.dias <= 7 && !yaRenovada(x.v))
    .sort((a, b) => a.dias - b.dias)
    .map(x => fila(x.v, { fecha: x.v.vigenciaFin, dias: x.dias }));

  // Cuotas: próximas 7 días y atrasadas
  const cuotasProximas = [], cuotasAtrasadas = [];
  seguros.filter(v => v.formaPago === 'cupones' || v.formaPago === 'debito_automatico').forEach(v => {
    const cron = Array.isArray(v.cronogramaCuotas) ? v.cronogramaCuotas : [];
    const pendientes = cron.map((q, i) => ({ ...q, n: i + 1 })).filter(q => !q.pagada && q.fecha);
    if (pendientes.length) {
      pendientes.forEach(q => {
        const dias = diasHasta(q.fecha);
        const item = fila(v, { fecha: q.fecha, dias, cuota: q.n, monto: q.monto, moneda: v.moneda === 'USD' ? 'US$' : 'S/' });
        if (dias >= 0 && dias <= 7) cuotasProximas.push(item);
        else if (dias < 0 && dias >= -90) cuotasAtrasadas.push(item);
      });
    } else if (v.proximaCuotaFecha) {
      const dias = diasHasta(v.proximaCuotaFecha);
      const monto = v.primaBruta ? Number(v.primaBruta) / (v.cantidadCuotas || 1) : null;
      const item = fila(v, { fecha: v.proximaCuotaFecha, dias, cuota: '', monto, moneda: v.moneda === 'USD' ? 'US$' : 'S/' });
      if (dias >= 0 && dias <= 7) cuotasProximas.push(item);
      else if (dias < 0 && dias >= -90) cuotasAtrasadas.push(item);
    }
  });
  cuotasProximas.sort((a, b) => a.dias - b.dias);
  cuotasAtrasadas.sort((a, b) => a.dias - b.dias);

  // Seguimientos y cotizaciones con fecha cumplida
  const tareas = (datos.seguimientos || []).filter(s => s.estado === 'abierto' && s.proximo && s.proximo <= HOY)
    .sort((a, b) => a.proximo.localeCompare(b.proximo))
    .map(s => ({
      cliente: (clientePorId[s.clienteId] || {}).nombre || s.clienteNombre || '—', fecha: s.proximo, dias: diasHasta(s.proximo),
      tipo: { cotizacion: 'Cotización', renovacion: 'Renovación', otro: 'Pendiente' }[s.tipo] || s.tipo || 'Pendiente',
      detalle: [prodLabel(s.producto), s.aseguradora, s.detalle].filter(x => x && x !== '—').join(' · '),
    }));

  // Cumpleaños de hoy
  const cumpleanos = datos.clientes.filter(c => c.fechaNacimiento && c.fechaNacimiento.slice(5, 10) === HOY.slice(5, 10))
    .map(c => ({ cliente: c.nombre, celular: c.celular1 || c.telefono || '' }));

  return { polizas, cuotasProximas, cuotasAtrasadas, tareas, cumpleanos };
}

// ---------------- correo ----------------
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const cuando = d => d === 0 ? '<b style="color:#B42318">Hoy</b>' : d === 1 ? '<b style="color:#B54708">Mañana</b>' : d < 0 ? `<b style="color:#B42318">Hace ${-d} d</b>` : `En ${d} días`;
const monto = (m, mon) => m == null ? '—' : `${mon} ${Number(m).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function tabla(titulo, columnas, filas) {
  const th = 'style="text-align:left;padding:6px 8px;background:#1F4B41;color:#fff;font-size:12px;"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #E4E7EC;font-size:12.5px;vertical-align:top;"';
  return `<h3 style="font-family:Arial,sans-serif;color:#1F4B41;margin:22px 0 6px;">${titulo} (${filas.length})</h3>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;">
<tr>${columnas.map(c => `<th ${th}>${c[0]}</th>`).join('')}</tr>
${filas.map(f => `<tr>${columnas.map(c => `<td ${td}>${c[1](f)}</td>`).join('')}</tr>`).join('')}
</table>`;
}

function armarCorreo(a) {
  const partes = [];
  if (a.polizas.length) partes.push(tabla('📄 Pólizas que vencen en los próximos 7 días', [
    ['Vence', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')],
    ['Póliza', f => esc(f.poliza)], ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Detalle', f => esc(f.detalle)],
  ], a.polizas));
  if (a.cuotasProximas.length) partes.push(tabla('💰 Cuotas que vencen en los próximos 7 días', [
    ['Vence', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')],
    ['Póliza', f => esc(f.poliza) + (f.cuota ? ` · cuota ${f.cuota}` : '')], ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Importe', f => monto(f.monto, f.moneda)],
  ], a.cuotasProximas));
  if (a.tareas.length) partes.push(tabla('📋 Seguimientos y cotizaciones para hoy', [
    ['Fecha', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Tipo', f => esc(f.tipo)], ['Cliente', f => esc(f.cliente)], ['Detalle', f => esc(f.detalle)],
  ], a.tareas));
  if (a.cuotasAtrasadas.length) partes.push(tabla('⚠️ Cuotas atrasadas (hasta 90 días)', [
    ['Venció', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')],
    ['Póliza', f => esc(f.poliza) + (f.cuota ? ` · cuota ${f.cuota}` : '')], ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Importe', f => monto(f.monto, f.moneda)],
  ], a.cuotasAtrasadas));
  if (a.cumpleanos.length) partes.push(tabla('🎂 Cumpleaños de hoy', [
    ['Cliente', f => esc(f.cliente)], ['Celular', f => esc(f.celular) || '—'],
  ], a.cumpleanos));

  const total = a.polizas.length + a.cuotasProximas.length + a.tareas.length;
  const asunto = `FG Pólizas · Alertas ${fmtDate(HOY)}: ${a.polizas.length} pólizas, ${a.cuotasProximas.length} cuotas, ${a.tareas.length} seguimientos`;
  const html = `<div style="font-family:Arial,sans-serif;color:#101828;max-width:820px;">
<p>Hola Eduardo,</p>
<p>${total ? 'Estos son los vencimientos y pendientes de tu cartera para los próximos días:' : 'Hoy no hay pólizas, cuotas ni seguimientos que venzan en los próximos 7 días.'}</p>
${partes.join('\n')}
<p style="margin-top:22px;"><a href="https://asesorespecializado18-gif.github.io/CRM-FG/" style="color:#1F4B41;font-weight:bold;">Abrir FG Pólizas</a></p>
<p style="color:#667085;font-size:12px;">Correo automático generado desde el CRM FG Pólizas.</p>
<p style="font-size:13px;line-height:1.5;">Eduardo Flores Chire<br>Jefe de Cuentas Empresas<br>Alta Corredores de Seguros S.A.C.<br>📱 937401941<br>✉ eflores@altacorredores.com</p>
</div>`;
  return { asunto, html };
}

async function enviar({ asunto, html }) {
  const { SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_USER || !SMTP_PASSWORD) throw new Error('Faltan SMTP_USER y SMTP_PASSWORD para enviar el correo.');
  const { default: nodemailer } = await import('nodemailer');
  const transporte = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASSWORD } });
  const para = (process.env.ALERTAS_PARA || DESTINO_DEFECTO).split(',').map(s => s.trim()).filter(Boolean);
  await transporte.sendMail({ from: `"FG Pólizas" <${SMTP_USER}>`, to: para.join(', '), subject: asunto, html });
  console.log(`Correo enviado a ${para.join(', ')}`);
}

const alertas = calcularAlertas(await cargarDatos());
const correo = armarCorreo(alertas);
console.log(`${HOY} · pólizas ${alertas.polizas.length} · cuotas próximas ${alertas.cuotasProximas.length} · atrasadas ${alertas.cuotasAtrasadas.length} · seguimientos ${alertas.tareas.length} · cumpleaños ${alertas.cumpleanos.length}`);
if (soloPrueba) {
  fs.writeFileSync('alertas.html', `<meta charset="utf-8"><title>${esc(correo.asunto)}</title>\n${correo.html}`);
  console.log('Modo prueba: el correo se guardó en alertas.html y no se envió.');
} else {
  await enviar(correo);
}
