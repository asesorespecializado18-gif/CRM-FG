// Alertas diarias de FG Pólizas: lee el CRM en Firebase y envía por correo
// lo que vence hoy, mañana y en los próximos 7 días.
//
// Uso:
//   node scripts/alertas-diarias.mjs                       → lee Firebase y envía el correo
//   node scripts/alertas-diarias.mjs --prueba              → lee Firebase y solo guarda el correo en alertas.html
//   node scripts/alertas-diarias.mjs --respaldo r.json     → usa un respaldo del CRM en vez de Firebase (implica --prueba)
//   node scripts/alertas-diarias.mjs --semanal             → resumen de los lunes: renovaciones de 30 días, cobranzas de la semana y todas las cuotas atrasadas
//   node scripts/alertas-diarias.mjs --mensual             → cierre del mes anterior: producción, comisiones, cobranza, renovaciones y lo que vence el mes siguiente
//
// Variables de entorno (secretos del repositorio en GitHub):
//   FG_EMAIL, FG_PASSWORD        usuario administrador del CRM (para leer Firebase)
//   SMTP_USER, SMTP_PASSWORD     cuenta de Gmail que envía y su contraseña de aplicación
//   ALERTAS_PARA                 destinatario(s), separados por coma (por defecto eflores@altacorredores.com)
//   FECHA_HOY                    opcional, AAAA-MM-DD, para simular otro día
//   MES_CIERRE                   opcional, AAAA-MM, mes que cierra el --mensual (por defecto el mes anterior)

import fs from 'node:fs';

const FIREBASE_API_KEY = 'AIzaSyADrF8yx_O0fIolJl2zutFtgi5VbyPv52c'; // la misma clave pública que usa index.html
const FIREBASE_PROJECT = 'crm-fg-21ec0';
const DESTINO_DEFECTO = 'eflores@altacorredores.com';

const args = process.argv.slice(2);
const rutaRespaldo = args.includes('--respaldo') ? args[args.indexOf('--respaldo') + 1] : null;
const soloPrueba = args.includes('--prueba') || !!rutaRespaldo;
const semanal = args.includes('--semanal');
const mensual = args.includes('--mensual');
// Ventanas en días: el diario mira 7 días; el semanal mira las renovaciones de todo el mes y todo lo atrasado del último año.
const DIAS_POLIZAS = semanal ? 30 : 7;
const DIAS_CUOTAS = 7;
const DIAS_ATRASO = semanal ? 365 : 90;

// ---------------- fechas (hora de Lima) ----------------
const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const HOY = process.env.FECHA_HOY || hoyLima();
const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasHasta = iso => Math.round((new Date(iso.slice(0, 10) + 'T00:00:00Z') - new Date(HOY + 'T00:00:00Z')) / 86400000);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = ym => `${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const mesSiguiente = ym => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const MES = process.env.MES_CIERRE || addDaysISO(HOY.slice(0, 8) + '01', -1).slice(0, 7);
const fmtDate = d => { if (!d) return '—'; const [y, m, day] = d.slice(0, 10).split('-'); return `${day}/${m}/${y}`; };

// ---------------- lectura de Firebase ----------------
async function iniciarSesion() {
  // los secretos pegados a mano suelen traer espacios o saltos de línea al inicio o al final
  const FG_EMAIL = (process.env.FG_EMAIL || '').trim(), FG_PASSWORD = (process.env.FG_PASSWORD || '').trim();
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
    return { clientes: d.clientes || [], ventas: d.ventas || [], seguimientos: d.seguimientos || [], productosPersonalizados: d.productosPersonalizados || [], asesores: d.asesores || [] };
  }
  const token = await iniciarSesion();
  const main = await leerFirestore(token, 'crm/main');
  const core = main.core || {};
  const [clientes, ventas] = await Promise.all([leerFirestore(token, 'crm_clientes'), leerFirestore(token, 'crm_ventas')]);
  return { clientes, ventas, seguimientos: core.seguimientos || [], productosPersonalizados: core.productosPersonalizados || [], asesores: core.asesores || [] };
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
    .filter(x => x.dias >= 0 && x.dias <= DIAS_POLIZAS && !yaRenovada(x.v))
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
        if (dias >= 0 && dias <= DIAS_CUOTAS) cuotasProximas.push(item);
        else if (dias < 0 && dias >= -DIAS_ATRASO) cuotasAtrasadas.push(item);
      });
    } else if (v.proximaCuotaFecha) {
      const dias = diasHasta(v.proximaCuotaFecha);
      const monto = v.primaBruta ? Number(v.primaBruta) / (v.cantidadCuotas || 1) : null;
      const item = fila(v, { fecha: v.proximaCuotaFecha, dias, cuota: '', monto, moneda: v.moneda === 'USD' ? 'US$' : 'S/' });
      if (dias >= 0 && dias <= DIAS_CUOTAS) cuotasProximas.push(item);
      else if (dias < 0 && dias >= -DIAS_ATRASO) cuotasAtrasadas.push(item);
    }
  });
  cuotasProximas.sort((a, b) => a.dias - b.dias);
  cuotasAtrasadas.sort((a, b) => a.dias - b.dias);

  // Seguimientos y cotizaciones con fecha cumplida
  const limiteTareas = semanal ? addDaysISO(HOY, 6) : HOY;
  const tareas = (datos.seguimientos || []).filter(s => s.estado === 'abierto' && s.proximo && s.proximo <= limiteTareas)
    .sort((a, b) => a.proximo.localeCompare(b.proximo))
    .map(s => ({
      cliente: (clientePorId[s.clienteId] || {}).nombre || s.clienteNombre || '—', fecha: s.proximo, dias: diasHasta(s.proximo),
      tipo: { cotizacion: 'Cotización', renovacion: 'Renovación', otro: 'Pendiente' }[s.tipo] || s.tipo || 'Pendiente',
      detalle: [prodLabel(s.producto), s.aseguradora, s.detalle].filter(x => x && x !== '—').join(' · '),
    }));

  // Cumpleaños de hoy (o de los próximos 7 días en el semanal)
  const diasCumple = semanal ? [0, 1, 2, 3, 4, 5, 6] : [0];
  const cumpleanos = diasCumple.flatMap(n => { const f = addDaysISO(HOY, n);
    return datos.clientes.filter(c => c.fechaNacimiento && c.fechaNacimiento.slice(5, 10) === f.slice(5, 10))
      .map(c => ({ cliente: c.nombre, celular: c.celular1 || c.telefono || '', fecha: f })); });

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
  if (a.polizas.length) partes.push(tabla(semanal ? '🔄 Renovaciones: pólizas que vencen en los próximos 30 días' : '📄 Pólizas que vencen en los próximos 7 días', [
    ['Vence', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')],
    ['Póliza', f => esc(f.poliza)], ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Detalle', f => esc(f.detalle)],
  ], a.polizas));
  if (a.cuotasProximas.length) partes.push(tabla(semanal ? '💰 Cobranzas de la semana: cuotas que vencen en los próximos 7 días' : '💰 Cuotas que vencen en los próximos 7 días', [
    ['Vence', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')],
    ['Póliza', f => esc(f.poliza) + (f.cuota ? ` · cuota ${f.cuota}` : '')], ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Importe', f => monto(f.monto, f.moneda)],
  ], a.cuotasProximas));
  if (a.tareas.length) partes.push(tabla(semanal ? '📋 Seguimientos y cotizaciones de la semana' : '📋 Seguimientos y cotizaciones para hoy', [
    ['Fecha', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Tipo', f => esc(f.tipo)], ['Cliente', f => esc(f.cliente)], ['Detalle', f => esc(f.detalle)],
  ], a.tareas));
  if (a.cuotasAtrasadas.length) partes.push(tabla(`⚠️ Cuotas atrasadas (hasta ${DIAS_ATRASO} días)`, [
    ['Venció', f => `${fmtDate(f.fecha)}<br>${cuando(f.dias)}`], ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')],
    ['Póliza', f => esc(f.poliza) + (f.cuota ? ` · cuota ${f.cuota}` : '')], ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Importe', f => monto(f.monto, f.moneda)],
  ], a.cuotasAtrasadas));
  if (a.cumpleanos.length) partes.push(tabla(semanal ? '🎂 Cumpleaños de la semana' : '🎂 Cumpleaños de hoy', [
    ...(semanal ? [['Fecha', f => fmtDate(f.fecha)]] : []), ['Cliente', f => esc(f.cliente)], ['Celular', f => esc(f.celular) || '—'],
  ], a.cumpleanos));

  const total = a.polizas.length + a.cuotasProximas.length + a.tareas.length + (semanal ? a.cuotasAtrasadas.length : 0);
  const asunto = semanal
    ? `FG Pólizas · Resumen semanal ${fmtDate(HOY)}: ${a.polizas.length} renovaciones, ${a.cuotasProximas.length} cobranzas, ${a.cuotasAtrasadas.length} cuotas atrasadas`
    : `FG Pólizas · Alertas ${fmtDate(HOY)}: ${a.polizas.length} pólizas, ${a.cuotasProximas.length} cuotas, ${a.tareas.length} seguimientos`;
  const intro = semanal
    ? (total ? 'Este es el resumen semanal de tu cartera: renovaciones del mes, cobranzas de la semana y cuotas atrasadas.' : 'Esta semana no hay renovaciones, cobranzas ni cuotas atrasadas pendientes.')
    : (total ? 'Estos son los vencimientos y pendientes de tu cartera para los próximos días:' : 'Hoy no hay pólizas, cuotas ni seguimientos que venzan en los próximos 7 días.');
  const html = `<div style="font-family:Arial,sans-serif;color:#101828;max-width:820px;">
<p>Hola Eduardo,</p>
<p>${intro}</p>
${partes.join('\n')}
<p style="margin-top:22px;"><a href="https://asesorespecializado18-gif.github.io/CRM-FG/" style="color:#1F4B41;font-weight:bold;">Abrir FG Pólizas</a></p>
<p style="color:#667085;font-size:12px;">Correo automático generado desde el CRM FG Pólizas.</p>
<p style="font-size:13px;line-height:1.5;">Eduardo Flores Chire<br>Jefe de Cuentas Empresas<br>Alta Corredores de Seguros S.A.C.<br>📱 937401941<br>✉ eflores@altacorredores.com</p>
</div>`;
  return { asunto, html };
}

// ---------------- cierre de mes ----------------
function calcularCierre(datos) {
  const personalizados = Object.fromEntries((datos.productosPersonalizados || []).map(p => [p.id, p]));
  const prodLabel = id => PRODUCTOS[id] || (personalizados[id] && personalizados[id].label) || id || '—';
  const esSeguro = id => !NO_SEGURO.has(id) && (!personalizados[id] || personalizados[id].categoria !== 'servicio');
  const clientePorId = Object.fromEntries(datos.clientes.map(c => [c.id, c]));
  const asesorPorId = Object.fromEntries((datos.asesores || []).map(a => [a.id, a]));
  const enMes = (f, ym = MES) => (f || '').slice(0, 7) === ym;
  const mon = v => v.moneda === 'USD' ? 'US$' : 'S/';
  const nombre = v => (clientePorId[v.clienteId] || {}).nombre || '—';
  const poliza = v => v.numeroPoliza || (v.folio ? 'V-' + String(v.folio).padStart(4, '0') : '—');
  const tipo = v => v.tipoVenta === 'endoso' ? 'Endoso' : v.tipoVenta === 'renovacion' ? 'Renovación' : 'Nueva';
  const sumar = (lista, campo) => lista.reduce((acc, x) => { const m = x.moneda; acc[m] = (acc[m] || 0) + (Number(x[campo]) || 0); return acc; }, {});
  const activas = datos.ventas.filter(v => v.estadoVenta !== 'anulada');

  // Producción: ventas emitidas en el mes
  const ventas = activas.filter(v => enMes(v.fechaVenta)).sort((a, b) => (a.fechaVenta || '').localeCompare(b.fechaVenta || ''))
    .map(v => ({ fecha: v.fechaVenta, cliente: nombre(v), poliza: poliza(v), tipo: tipo(v), producto: prodLabel(v.tipoProducto), aseguradora: v.aseguradora || '',
      asesor: (asesorPorId[v.asesorId] || {}).nombre || 'Sin asesor', moneda: mon(v), primaNeta: Number(v.primaNeta) || 0, comision: Number(v.comisionTotal) || 0 }));
  const agrupar = clave => Object.values(ventas.reduce((acc, f) => { const k = f[clave];
    const g = (acc[k] = acc[k] || { nombre: k, cantidad: 0, primaNeta: {}, comision: {} });
    g.cantidad++; g.primaNeta[f.moneda] = (g.primaNeta[f.moneda] || 0) + f.primaNeta; g.comision[f.moneda] = (g.comision[f.moneda] || 0) + f.comision; return acc; }, {}))
    .sort((a, b) => b.cantidad - a.cantidad);

  // Anulaciones del mes
  const anuladas = datos.ventas.filter(v => v.estadoVenta === 'anulada' && enMes(v.fechaAnulacion || v.fechaVenta) && (v.fechaAnulacion ? true : enMes(v.fechaVenta)))
    .map(v => ({ fecha: v.fechaAnulacion || v.fechaVenta, cliente: nombre(v), poliza: poliza(v), producto: prodLabel(v.tipoProducto), aseguradora: v.aseguradora || '',
      motivo: v.motivoAnulacion === 'otro' ? (v.otroMotivoAnulacion || 'Otro') : (v.motivoAnulacion || '') }));

  // Comisiones cobradas en el mes y pendientes de cobro
  const comisionesPagadas = activas.filter(v => v.estadoComision === 'pagada' && enMes(v.fechaPagoComision))
    .map(v => ({ fecha: v.fechaPagoComision, cliente: nombre(v), poliza: poliza(v), aseguradora: v.aseguradora || '', moneda: mon(v), comision: Number(v.comisionTotal) || 0 }));
  const comisionesPendientes = activas.filter(v => v.estadoComision !== 'pagada' && (Number(v.comisionTotal) || 0) > 0 && (v.fechaVenta || '') <= MES + '-31')
    .map(v => ({ moneda: mon(v), comision: Number(v.comisionTotal) || 0 }));

  // Cobranza: cuotas que vencían en el mes
  const cuotas = [];
  activas.filter(v => esSeguro(v.tipoProducto) && Array.isArray(v.cronogramaCuotas)).forEach(v => v.cronogramaCuotas.forEach((q, i) => {
    if (q && enMes(q.fecha)) cuotas.push({ fecha: q.fecha, cliente: nombre(v), poliza: poliza(v), cuota: i + 1, aseguradora: v.aseguradora || '', moneda: mon(v), monto: Number(q.monto) || 0, pagada: !!q.pagada });
  }));
  cuotas.sort((a, b) => a.fecha.localeCompare(b.fecha));

  // Renovaciones: pólizas que vencían en el mes y qué pasó con ellas
  const familia = t => /^sctr/.test(t || '') ? 'sctr' : t;
  const renovadaPor = v => activas.find(v2 => v2.id !== v.id && v2.clienteId === v.clienteId && familia(v2.tipoProducto) === familia(v.tipoProducto)
    && (v2.renuevaVentaId === v.id || (() => { const ini = v2.vigenciaInicio || v2.fechaVenta || ''; return ini >= addDaysISO(v.vigenciaFin, -60) && ini <= addDaysISO(v.vigenciaFin, 60); })()));
  const vencidas = activas.filter(v => v.tipoVenta !== 'endoso' && esSeguro(v.tipoProducto) && enMes(v.vigenciaFin)).sort((a, b) => a.vigenciaFin.localeCompare(b.vigenciaFin))
    .map(v => { const est = (v.renov || {}).estado; const r = renovadaPor(v);
      return { fecha: v.vigenciaFin, cliente: nombre(v), poliza: poliza(v), producto: prodLabel(v.tipoProducto), aseguradora: v.aseguradora || '',
        estado: (r || est === 'renovado') ? 'Renovada' : est === 'no_renueva' ? 'No renueva' : 'Pendiente' }; });

  // Lo que viene: pólizas que vencen el mes siguiente
  const proximoMes = mesSiguiente(MES);
  const proximas = activas.filter(v => v.tipoVenta !== 'endoso' && esSeguro(v.tipoProducto) && enMes(v.vigenciaFin, proximoMes) && !['renovado', 'no_renueva'].includes((v.renov || {}).estado))
    .sort((a, b) => a.vigenciaFin.localeCompare(b.vigenciaFin))
    .map(v => { const c = clientePorId[v.clienteId] || {}; return { fecha: v.vigenciaFin, cliente: c.nombre || '—', celular: c.celular1 || c.telefono || '', poliza: poliza(v),
      producto: prodLabel(v.tipoProducto), aseguradora: v.aseguradora || '', moneda: mon(v), primaNeta: Number(v.primaNeta) || 0 }; });

  return { ventas, porProducto: agrupar('producto'), porAseguradora: agrupar('aseguradora'), porAsesor: agrupar('asesor'), anuladas,
    comisionesPagadas, comisionesPendientes, cuotas, vencidas, proximas, proximoMes,
    totales: { prima: sumar(ventas, 'primaNeta'), comision: sumar(ventas, 'comision'), cobrada: sumar(comisionesPagadas, 'comision'), pendiente: sumar(comisionesPendientes, 'comision'),
      cuotasPagadas: sumar(cuotas.filter(q => q.pagada), 'monto'), cuotasPendientes: sumar(cuotas.filter(q => !q.pagada), 'monto') } };
}

function armarCierre(a) {
  const totalTxt = t => Object.keys(t).length ? Object.entries(t).sort().reverse().map(([m, x]) => monto(x, m)).join(' + ') : monto(0, 'US$');
  const caja = (titulo, valor, sub) => `<td style="padding:10px 12px;border:1px solid #E4E7EC;vertical-align:top;width:25%;"><div style="font-size:11.5px;color:#667085;">${titulo}</div><div style="font-size:16px;font-weight:bold;color:#1F4B41;margin-top:3px;">${valor}</div>${sub ? `<div style="font-size:11.5px;color:#667085;margin-top:2px;">${sub}</div>` : ''}</td>`;
  const renov = a.vencidas.reduce((acc, f) => (acc[f.estado] = (acc[f.estado] || 0) + 1, acc), {});
  const nuevas = a.ventas.filter(f => f.tipo === 'Nueva').length, renovs = a.ventas.filter(f => f.tipo === 'Renovación').length, endosos = a.ventas.filter(f => f.tipo === 'Endoso').length;
  const pagadas = a.cuotas.filter(q => q.pagada).length;
  const resumen = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;margin-top:8px;"><tr>
${caja('Pólizas emitidas', a.ventas.length, `${nuevas} nuevas · ${renovs} renovaciones · ${endosos} endosos`)}
${caja('Prima neta', totalTxt(a.totales.prima), '')}
${caja('Comisión generada', totalTxt(a.totales.comision), '')}
${caja('Comisión cobrada en el mes', totalTxt(a.totales.cobrada), `Pendiente total: ${totalTxt(a.totales.pendiente)}`)}
</tr><tr>
${caja('Cuotas del mes', `${pagadas} de ${a.cuotas.length} pagadas`, `Por cobrar: ${totalTxt(a.totales.cuotasPendientes)}`)}
${caja('Vencimientos del mes', a.vencidas.length, `${renov['Renovada'] || 0} renovadas · ${renov['No renueva'] || 0} no renuevan · ${renov['Pendiente'] || 0} pendientes`)}
${caja('Anuladas', a.anuladas.length, '')}
${caja(`Vencen en ${nombreMes(a.proximoMes)}`, a.proximas.length, 'por renovar')}
</tr></table>`;
  const grupo = (titulo, filas) => tabla(titulo, [['', f => esc(f.nombre)], ['Pólizas', f => f.cantidad], ['Prima neta', f => totalTxt(f.primaNeta)], ['Comisión', f => totalTxt(f.comision)]], filas);
  const partes = [resumen];
  if (a.ventas.length) {
    partes.push(grupo('📊 Producción por producto', a.porProducto));
    partes.push(grupo('🏢 Producción por aseguradora', a.porAseguradora));
    if (a.porAsesor.length > 1) partes.push(grupo('👤 Producción por asesor', a.porAsesor));
    partes.push(tabla('📝 Detalle de pólizas emitidas', [['Fecha', f => fmtDate(f.fecha)], ['Cliente', f => esc(f.cliente)], ['Póliza', f => `${esc(f.poliza)}<br><span style="color:#667085">${f.tipo}</span>`],
      ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Prima neta', f => monto(f.primaNeta, f.moneda)], ['Comisión', f => monto(f.comision, f.moneda)]], a.ventas));
  }
  if (a.vencidas.length) partes.push(tabla('🔄 Pólizas que vencían en el mes', [['Venció', f => fmtDate(f.fecha)], ['Cliente', f => esc(f.cliente)], ['Póliza', f => esc(f.poliza)],
    ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`],
    ['Estado', f => f.estado === 'Renovada' ? '<b style="color:#067647">Renovada</b>' : f.estado === 'No renueva' ? '<span style="color:#667085">No renueva</span>' : '<b style="color:#B42318">Pendiente</b>']], a.vencidas));
  const cuotasPend = a.cuotas.filter(q => !q.pagada);
  if (cuotasPend.length) partes.push(tabla('💰 Cuotas del mes sin pagar', [['Venció', f => fmtDate(f.fecha)], ['Cliente', f => esc(f.cliente)], ['Póliza', f => `${esc(f.poliza)} · cuota ${f.cuota}`],
    ['Aseguradora', f => esc(f.aseguradora)], ['Importe', f => monto(f.monto, f.moneda)]], cuotasPend));
  if (a.comisionesPagadas.length) partes.push(tabla('💵 Comisiones cobradas en el mes', [['Fecha', f => fmtDate(f.fecha)], ['Cliente', f => esc(f.cliente)], ['Póliza', f => esc(f.poliza)],
    ['Aseguradora', f => esc(f.aseguradora)], ['Comisión', f => monto(f.comision, f.moneda)]], a.comisionesPagadas));
  if (a.anuladas.length) partes.push(tabla('❌ Pólizas anuladas', [['Fecha', f => fmtDate(f.fecha)], ['Cliente', f => esc(f.cliente)], ['Póliza', f => esc(f.poliza)],
    ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Motivo', f => esc(f.motivo) || '—']], a.anuladas));
  if (a.proximas.length) partes.push(tabla(`📅 Para preparar: pólizas que vencen en ${nombreMes(a.proximoMes)}`, [['Vence', f => fmtDate(f.fecha)],
    ['Cliente', f => esc(f.cliente) + (f.celular ? `<br><span style="color:#667085">${esc(f.celular)}</span>` : '')], ['Póliza', f => esc(f.poliza)],
    ['Producto', f => `${esc(f.producto)}<br><span style="color:#667085">${esc(f.aseguradora)}</span>`], ['Prima neta', f => monto(f.primaNeta, f.moneda)]], a.proximas));

  const asunto = `FG Pólizas · Cierre de ${nombreMes(MES)}: ${a.ventas.length} pólizas, comisión ${totalTxt(a.totales.comision)}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#101828;max-width:820px;">
<p>Hola Eduardo,</p>
<p>Este es el cierre de <b>${nombreMes(MES)}</b> de tu cartera: producción, comisiones, cobranza y renovaciones, y lo que vence el mes que viene.</p>
${partes.join('\n')}
<p style="margin-top:22px;"><a href="https://asesorespecializado18-gif.github.io/CRM-FG/" style="color:#1F4B41;font-weight:bold;">Abrir FG Pólizas</a></p>
<p style="color:#667085;font-size:12px;">Correo automático generado desde el CRM FG Pólizas. Los montos se muestran en la moneda de cada póliza, sin convertir.</p>
<p style="font-size:13px;line-height:1.5;">Eduardo Flores Chire<br>Jefe de Cuentas Empresas<br>Alta Corredores de Seguros S.A.C.<br>📱 937401941<br>✉ eflores@altacorredores.com</p>
</div>`;
  return { asunto, html };
}

async function enviar({ asunto, html }) {
  const SMTP_USER = (process.env.SMTP_USER || '').trim(), SMTP_PASSWORD = (process.env.SMTP_PASSWORD || '').replace(/\s+/g, ''); // Google muestra la contraseña de aplicación con espacios
  if (!SMTP_USER || !SMTP_PASSWORD) throw new Error('Faltan SMTP_USER y SMTP_PASSWORD para enviar el correo.');
  const { default: nodemailer } = await import('nodemailer');
  const transporte = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASSWORD } });
  const para = (process.env.ALERTAS_PARA || DESTINO_DEFECTO).split(',').map(s => s.trim()).filter(Boolean);
  await transporte.sendMail({ from: `"FG Pólizas" <${SMTP_USER}>`, to: para.join(', '), subject: asunto, html });
  console.log(`Correo enviado a ${para.join(', ')}`);
}

const datos = await cargarDatos();
let correo;
if (mensual) {
  const cierre = calcularCierre(datos);
  correo = armarCierre(cierre);
  console.log(`Cierre ${MES} · pólizas ${cierre.ventas.length} · anuladas ${cierre.anuladas.length} · cuotas ${cierre.cuotas.length} · vencidas ${cierre.vencidas.length} · vencen el mes siguiente ${cierre.proximas.length}`);
} else {
  const alertas = calcularAlertas(datos);
  correo = armarCorreo(alertas);
  console.log(`${HOY}${semanal ? ' (semanal)' : ''} · pólizas ${alertas.polizas.length} · cuotas próximas ${alertas.cuotasProximas.length} · atrasadas ${alertas.cuotasAtrasadas.length} · seguimientos ${alertas.tareas.length} · cumpleaños ${alertas.cumpleanos.length}`);
}
if (soloPrueba) {
  fs.writeFileSync('alertas.html', `<meta charset="utf-8"><title>${esc(correo.asunto)}</title>\n${correo.html}`);
  console.log('Modo prueba: el correo se guardó en alertas.html y no se envió.');
} else {
  await enviar(correo);
}
