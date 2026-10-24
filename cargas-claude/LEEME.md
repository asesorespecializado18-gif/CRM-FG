# Cargas de Claude al CRM FG

Claude prepara cambios para el CRM (pagos de comisión, anulaciones, renovaciones, cuotas pagadas, notas, siniestros, historial de pólizas) y los deja **pendientes** en el CRM. Nada se aplica solo: el administrador los revisa en **Cobro de Comisiones › 🤖 Cargas de Claude** y pulsa **Aplicar**.

## Cómo funciona

1. Claude arma el archivo de cambios (`fg-acciones-v1` o `fg-historial-polizas-v1`, los mismos de "📂 Importar historial") y lo cifra con `scripts/cifrar-carga-claude.mjs` usando `llave-publica.pem`.
2. Lo sube a la rama `cargas-claude`. Como el repositorio es público, el archivo va cifrado: nadie puede leer los datos de los clientes.
3. La Action **Cargas de Claude** entra a Firebase con el usuario `claude-bot@altacorredores.com` y deja la carga en `crm_cargas_claude` como pendiente. Ese usuario, según las reglas, solo puede crear cargas: no puede leer, cambiar ni borrar nada del CRM.
4. En el CRM, el administrador ve el título y el resumen de cada carga y elige **Aplicar** o **Descartar**. Al aplicar:
   - se guarda primero un respaldo automático (aparece en ☁ Respaldos automáticos como `AAAA-MM-DD-claude-HHMM`);
   - se aplican los cambios con la misma lógica de "Importar historial": solo agrega o completa, no reemplaza la base y no duplica si se aplica dos veces;
   - queda en el historial de cambios como "🤖 Carga de Claude".

## Puesta en marcha (una sola vez)

1. **Firebase › Authentication › Users › Agregar usuario**: correo `claude-bot@altacorredores.com` y una clave larga que usted invente. No la comparta con nadie, tampoco con Claude.
2. **Firebase › Firestore Database › Reglas**: pegar `firestore.rules` y Publicar. **Firebase › Storage › Reglas**: pegar `storage.rules` y Publicar.
3. **GitHub › CRM-FG › Settings › Secrets and variables › Actions › New repository secret**: `CRM_BOT_EMAIL` (el correo) y `CRM_BOT_PASSWORD` (la clave).
4. **CRM › Cobro de Comisiones › 🤖 Cargas de Claude › Activar cargas de Claude**: copia la llave pública que aparece y pégasela a Claude en el chat (no es secreta). Claude la guarda como `cargas-claude/llave-publica.pem`.

## Para quitarle el acceso a Claude

Borrar o desactivar el usuario `claude-bot@altacorredores.com` en Firebase › Authentication. Las cargas pendientes se pueden descartar desde el CRM.
