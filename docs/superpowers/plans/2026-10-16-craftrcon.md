# CraftRCON — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir CraftRCON, un panel web de código abierto para administrar servidores de Minecraft por RCON, con su instalador `./install` y su actualizador `./update` para Linux.

**Architecture:**
- **Backend:** Node.js (ESM) con Fastify. Guarda todo en SQLite (`node:sqlite`) y habla con los servidores de Minecraft solo por red, con un cliente RCON y Server List Ping propios.
- **Frontend:** SPA sin compilación con Preact + htm incluidos en el repo, servida por el mismo Fastify.
- **Instalación:** scripts bash (con un arranque POSIX `sh`) que instalan un Node privado, crean el servicio y gestionan las actualizaciones por el archivo `VERSION`.

**Tech Stack:**
- Node.js ≥ 22.13 con `node:sqlite`, `node:test` y `node:crypto`.
- `fastify@5`, `@fastify/static`, `@fastify/cookie` y `@fastify/websocket`.
- `htm@3` (`htm/preact/standalone`) incluido en `public/vendor/`.
- Bash para el instalador; systemd/OpenRC; Caddy opcional para HTTPS.

**Spec:** `docs/superpowers/specs/2026-10-16-minecraft-rcon-panel-design.md` (en español; las secciones se citan como §N).

## Global Constraints

- Nombre visible: `CraftRCON`. Identificador técnico: `craftrcon` (usuario de sistema, servicio, carpetas). Repositorio: `https://github.com/solqubit/craftrcon.git`.
- **Rutas en el servidor:**
  - `/opt/craftrcon/app` (código)
  - `/opt/craftrcon/node` (Node privado)
  - `/opt/craftrcon/installed.json` (versión instalada)
  - `/var/lib/craftrcon` (datos)
  - `/etc/craftrcon/config.json` (configuración)
- Node mínimo: **22.13.0**. `package.json` → `"engines": { "node": ">=22.13.0" }`, `"type": "module"`.
- Cero dependencias nativas (nada de `node-gyp`). Cero recursos cargados desde CDN en la interfaz.
- La contraseña RCON **nunca** sale del backend: ninguna respuesta de la API la incluye, ni cifrada.
- Idioma por defecto **inglés** (`en`). También `es`. Todo texto visible de la interfaz sale de `locales/<lang>.json`; el del instalador, de `scripts/lib/messages.<lang>.sh`.
- **Valores fijos de la spec:**
  - Puerto RCON por defecto: 25575.
  - Puerto del juego: 25565.
  - Puerto del panel: 8080.
  - Clave mínima: 8 caracteres.
  - La sesión expira tras 7 días sin uso.
  - Muestras de jugadores: cada 60 s, se guardan 7 días.
  - Historial de comandos: 200 por servidor.
  - Registro de acciones: 90 días.
  - Respaldos de `./update`: últimos 5.
- Comandos que piden confirmación por defecto: `stop`, `op`, `deop`, `ban-ip`, `kill @e`, `whitelist off`, `difficulty`.
- **Colores Obsidian** (variables CSS):
  - `--bg #0b0d10`
  - `--panel #111418`
  - `--border #1d2228`
  - `--accent #34d399`
  - `--danger #f87171`
  - `--warn #fbbf24`
  - Radios de 7–12 px.
  - Solo tema oscuro.
- Funciones "inteligentes" (parsers, autocompletado, gamerules) objetivo Java 1.16+. Si un parser no reconoce la respuesta, se devuelve `{ raw }` y la UI la muestra en crudo, nunca un error.
- Commits pequeños por tarea. Licencia MIT.

## Review Focus

1. **Comandos con salto de línea, `\0` o más de 1446 bytes** (p. ej. un nombre pegado con `\n`): el backend los rechaza con `400 invalid_command` y no los envía al servidor. → test en Tarea 12.
2. **Texto en español con tildes y `ñ`** (`say ¡Hola, señores!`): llega intacto al servidor y la respuesta UTF-8 se decodifica bien, aunque un carácter multibyte quede partido entre dos paquetes. → tests en Tareas 7 y 8.
3. **El servidor de Minecraft se reinicia a mitad de sesión:** el comando en vuelo falla con un error claro y el siguiente reconecta solo, sin recargar el panel. → test en Tarea 8.
4. **Servidor apagado o host inexistente** en Dashboard o Servers: estado "Offline" en ≤ 3 s y sin errores 500. → test en Tareas 9 y 13.
5. **Nombre de jugador malicioso en el proxy de cabezas** (`../../etc/passwd`, 17+ caracteres): `400` sin tocar disco ni red; se responde con la cabeza genérica. → test en Tarea 15.

---

## Mapa de archivos

```
VERSION                         semver, empieza en 0.1.0
package.json / package-lock.json
install, update                 arranque POSIX sh → exec bash scripts/*.sh
scripts/install.sh, update.sh   flujos bash
scripts/lib/common.sh           log, i18n, root, detección, version_cmp, health
scripts/lib/node.sh             instalar Node privado
scripts/lib/service.sh          systemd/OpenRC, firewall, caddy
scripts/lib/messages.en.sh/.es.sh
scripts/templates/              craftrcon.service, craftrcon.openrc, craftrcon-proxy.service, craftrcon-proxy.openrc, Caddyfile.tmpl
scripts/vendor.js               copia htm/preact standalone a public/vendor
scripts/gen-items.js            genera public/js/data/items.js desde minecraft-data
scripts/dev-fake-server.js      Minecraft falso para desarrollo de UI
src/server.js                   entrada: config → db → app → listen
src/app.js                      buildApp(deps) → instancia Fastify
src/config.js                   loadConfig()
src/cli.js                      init | set-password
src/db/index.js, db/migrations/001_init.sql
src/security/password.js, secretbox.js, sessions.js, rateLimit.js
src/minecraft/rcon.js           RconClient
src/minecraft/connection.js     ServerConnection, ConnectionManager
src/minecraft/ping.js           serverListPing, componentToLegacy
src/minecraft/parsers.js        parseList, parseBanlist, parseWhitelist, parseTps, parseGamerule
src/minecraft/validate.js       validateCommand (reexporta isValidPlayerName de public/js/lib/names.js)
src/services/servers.js, commands.js, hub.js, status.js, sampler.js, heads.js, scheduler.js, settings.js, audit.js, updateCheck.js
src/routes/auth.js, servers.js, console.js, live.js, info.js, heads.js, tasks.js, settings.js
public/index.html, css/app.css, vendor/htm-preact.js, img/head-fallback.svg
public/js/main.js, api.js, i18n.js, router.js, store.js
public/js/lib/mctext.js         parseLegacy, stripCodes (compartido con backend)
public/js/lib/names.js          isValidPlayerName, oneLine (compartido con backend)
public/js/lib/autocomplete.js, builders.js, tellraw.js
public/js/data/commands.js, gamerules.js, items.js
public/js/components/*.js       Layout, Modal, Confirm, Toast, McText, Head, LineChart, Empty
public/js/pages/*.js            Login, Dashboard, Console, Players, Moderation, World, Tasks, Servers, Settings
locales/en.json, es.json
test/**/*.test.js, test/fixtures/fakeMinecraft.js, test/shell/*.sh
.github/workflows/ci.yml
README.md, README.es.md, LICENSE
```

---

## Fase 1 — Base

### Tarea 1: Esqueleto del proyecto y health check

**Files:**
- Create: `package.json`, `VERSION`, `LICENSE`, `src/config.js`, `src/app.js`, `src/server.js`, `test/app.test.js`
- Modify: `.gitignore` (añadir `data/`)

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env) -> { host, port, dataDir, domain, trustProxy, version }`. Lee el JSON de `env.CRAFTRCON_CONFIG` si existe. Defaults: `host "0.0.0.0"`, `port 8080`, `dataDir "./data"`, `domain null`, `trustProxy false`. `version` se lee de `VERSION` (trim).
  - `buildApp({ config, db, services }) -> FastifyInstance`, sin escuchar todavía. Las tareas siguientes registran sus rutas aquí.
  - `GET /api/health -> 200 { ok: true, version }`, sin auth.

- [ ] **Step 1:** `package.json` con:
  - scripts: `"start": "node src/server.js"`, `"dev": "node --watch src/server.js"`, `"test": "node --test test/"`, `"test:shell": "bash test/shell/run.sh"`, `"vendor": "node scripts/vendor.js"`, `"fake-mc": "node scripts/dev-fake-server.js"`.
  - deps: `fastify@^5`, `@fastify/static`, `@fastify/cookie`, `@fastify/websocket`.
  - devDeps: `htm@^3.1.1`, `minecraft-data`.
  - `npm install`, para que exista `package-lock.json`.

  `VERSION` = `0.1.0`. `LICENSE` MIT a nombre de "CraftRCON contributors".
- [ ] **Step 2: Test que falla** en `test/app.test.js`:
  ```js
  test('health returns ok and version', async () => {
    const app = buildApp({ config: { ...loadConfig({}), version: '0.1.0' }, db: null, services: {} });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, version: '0.1.0' });
  });
  ```
- [ ] **Step 3:** `npm test`. Esperado: FAIL (módulo no existe).
- [ ] **Step 4:** Implementar `config.js`, `app.js` y `server.js`.
- [ ] **Step 5:** `npm test`. Esperado: PASS.
- [ ] **Step 6:** Commit `chore: scaffold CraftRCON app with health endpoint`.

### Tarea 2: Base de datos y migraciones

**Files:**
- Create: `src/db/index.js`, `src/db/migrations/001_init.sql`, `test/db.test.js`

**Interfaces:**
- Produces: `openDb(file: string) -> DatabaseSync`.
  - Activa `PRAGMA foreign_keys=ON` y `journal_mode=WAL`.
  - Aplica en orden los `migrations/NNN_*.sql` con número mayor que `PRAGMA user_version`, cada uno en su transacción, y deja `user_version = NNN`.
  - `':memory:'` vale para los tests.
- Esquema `001_init.sql` (las tareas siguientes usan estos nombres):
  - `servers(id INTEGER PK, name TEXT UNIQUE NOT NULL COLLATE NOCASE, host TEXT NOT NULL, rcon_port INTEGER NOT NULL DEFAULT 25575, rcon_password_enc TEXT NOT NULL, game_port INTEGER NOT NULL DEFAULT 25565, icon TEXT NOT NULL DEFAULT 'mountain', color TEXT NOT NULL DEFAULT 'emerald', created_at INTEGER, updated_at INTEGER)`
  - `settings(key TEXT PK, value TEXT NOT NULL)`
  - `sessions(id_hash TEXT PK, created_at INTEGER, last_seen INTEGER)`
  - `favorites(id PK, server_id FK→servers ON DELETE CASCADE, label TEXT, command TEXT, position INTEGER)`
  - `command_history(id PK, server_id FK CASCADE, command TEXT, ts INTEGER)`
  - `tasks(id PK, server_id FK CASCADE, name TEXT, enabled INTEGER, trigger_type TEXT CHECK IN ('interval','daily'), interval_minutes INTEGER, daily_time TEXT, steps TEXT /*JSON*/, last_run_at INTEGER, next_run_at INTEGER)`
  - `audit(id PK, ts INTEGER, server_id FK CASCADE NULL, origin TEXT CHECK IN ('console','ui','task','auth','system'), action TEXT, detail TEXT, ok INTEGER, result TEXT)`
  - `player_samples(server_id FK CASCADE, ts INTEGER, online INTEGER, max INTEGER)`, más un índice `(server_id, ts)`.

  Todos los `ts` son milisegundos epoch.

- [ ] **Step 1: Tests que fallan:**
  - `openDb(':memory:')` deja `user_version` = 1 y existen las 8 tablas (consulta a `sqlite_master`).
  - Abrir dos veces el mismo archivo temporal no falla y no duplica nada.
  - Al borrar un `servers` se borran en cascada sus `favorites`, `command_history`, `tasks`, `audit` y `player_samples`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar `openDb` y `001_init.sql`.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(db): sqlite schema with versioned migrations`.

### Tarea 3: Clave de acceso y cifrado de contraseñas RCON

**Files:**
- Create: `src/security/password.js`, `src/security/secretbox.js`, `test/security.test.js`

**Interfaces:**
- Produces:
  - `hashPassword(plain) -> Promise<string>`: formato `scrypt$16384$8$1$<saltB64>$<hashB64>`, salt de 16 bytes y key de 64 bytes.
  - `verifyPassword(plain, stored) -> Promise<boolean>`: usa `timingSafeEqual`.
  - `loadOrCreateKey(file) -> Buffer(32)`: si no existe, crea 32 bytes aleatorios con modo `0o600`.
  - `encryptSecret(key, plain) -> "v1:<ivB64>:<tagB64>:<ctB64>"`: AES-256-GCM con IV de 12 bytes.
  - `decryptSecret(key, blob) -> string`: lanza un error si el blob fue alterado.

- [ ] **Step 1: Tests que fallan:**
  - Hash y verify con la clave correcta → `true`; con otra → `false`.
  - Dos hashes de la misma clave son distintos (salt).
  - Ida y vuelta de `encrypt`/`decrypt` con `'contraseña_ñ'` devuelve el original.
  - Alterar un byte del texto cifrado → `throws`.
  - Con otra key → `throws`.
  - `loadOrCreateKey` dos veces devuelve el mismo Buffer.
  - En Linux, el modo del archivo es `0o600` (`{ skip: process.platform === 'win32' }`).
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar con `node:crypto` (`scrypt`, `randomBytes`, `createCipheriv('aes-256-gcm')`).
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(security): scrypt admin password and AES-GCM secret storage`.

### Tarea 4: CLI `init` y `set-password`

**Files:**
- Create: `src/cli.js`, `src/services/settings.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `openDb`, `hashPassword`, `loadOrCreateKey`, `loadConfig`.
- Produces:
  - `node src/cli.js init`: crea `dataDir`, aplica migraciones, crea `dataDir/secret.key` y termina con código 0.
  - `node src/cli.js set-password`: lee la clave de **stdin** (primera línea, sin `\n`). Si tiene menos de 8 caracteres, sale con 2 y `password_too_short` en stderr. Si no, guarda el hash en `settings.admin_password_hash`, borra todas las `sessions` y sale con 0.
  - `createSettings(db) -> { get(key, fallback), set(key, value), getJson(key, fallback), setJson(key, value) }`.

- [ ] **Step 1: Tests que fallan:**
  - Lanzan el CLI con `spawnSync(process.execPath, ['src/cli.js', ...], { env: { CRAFTRCON_CONFIG: tmpConfig }, input: 'secret123\n' })`.
  - `init` y después `set-password` → status 0, y `verifyPassword('secret123', hash guardado)` da `true`.
  - `input: 'short\n'` → status 2.
  - `set-password` borra las sesiones existentes.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(cli): init and set-password commands`.

### Tarea 5: Login, sesiones, límite de intentos y verificación de Origin

**Files:**
- Create: `src/security/sessions.js`, `src/security/rateLimit.js`, `src/services/audit.js`, `src/routes/auth.js`, `test/auth.test.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces:
  - `createSessions(db, { idleMs = 7*24*3600e3 }) -> { create(): token, validate(token): boolean /*actualiza last_seen*/, destroy(token), destroyAll() }`. El token es de 32 bytes en base64url; en la DB solo se guarda su SHA-256.
  - `createRateLimiter({ maxFails = 5, baseLockMs = 60_000, maxLockMs = 30*60_000 }) -> { check(ip) -> { allowed, retryAfterMs }, fail(ip), success(ip) }`. Cada bloqueo nuevo duplica la espera, hasta el máximo.
  - `createAudit(db) -> { log({ serverId=null, origin, action, detail, ok=true, result=null }), list({ serverId, limit=100, before }), purge(olderThanMs) }`.
  - Rutas:
    - `POST /api/login { password } → 204` con cookie `craftrcon_sid` (`HttpOnly; SameSite=Strict; Path=/`, y `Secure` si `config.domain`). Clave errónea → `401 { error: 'invalid_password' }`. Bloqueado → `429 { error: 'too_many_attempts', retryAfterMs }`.
    - `POST /api/logout → 204`.
    - `GET /api/me → 200 { authenticated: true }`, o `401`.
  - Hook global: todo `/api/*` excepto `/api/health` y `/api/login` exige una sesión válida (`401 { error: 'unauthorized' }`). Las peticiones no-GET exigen un `Origin` cuyo host coincida con `Host` (o con `X-Forwarded-Host` si `trustProxy`); si no, `403 { error: 'bad_origin' }`.
  - Audit: `login_ok` y `login_fail` con `origin 'auth'` y la IP en `detail`.

- [ ] **Step 1: Tests que fallan** (`app.inject`):
  - Login correcto → 204 y la cookie trae `HttpOnly` y `SameSite=Strict`.
  - `GET /api/me` con esa cookie → 200; sin cookie → 401.
  - 5 claves erróneas seguidas → la 6.ª da 429 aunque la clave sea correcta.
  - POST con `Origin: http://evil.test` y `Host: panel.test` → 403.
  - Una sesión con `last_seen` de hace 8 días → 401.
  - Login fallido → aparece una fila `audit` con `action='login_fail'`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar y registrar en `buildApp`. `services.sessions` y `services.audit` se inyectan.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(auth): session login with rate limiting and origin check`.

---

## Fase 2 — Protocolo Minecraft

### Tarea 6: Servidor Minecraft falso (fixture de pruebas y desarrollo)

**Files:**
- Create: `test/fixtures/fakeMinecraft.js`, `scripts/dev-fake-server.js`, `test/fake.test.js`

**Interfaces:**
- Produces: `startFakeMinecraft({ password = 'test', rconPort = 0, gamePort = 0, handlers = {}, split = false }) -> Promise<{ rconPort, gamePort, received: string[], dropConnections(), setOnline(bool), close() }>`.
  - **RCON real:** auth (tipo 3 → respuesta tipo 2, id `-1` si la clave es incorrecta) y exec (tipo 2 → tipo 0).
  - **Respuestas:** `handlers[cmdName](args) -> string`. Los defaults imitan Paper 1.21: `list` → `"There are 2 of a max of 20 players online: Steve, Alex"`, `tps` → `"§6TPS from last 1m, 5m, 15m: §a20.0, §a*20.0, §a19.97"`, y además `banlist`, `whitelist list`, `gamerule <x>`, `say` y un desconocido → `"Unknown or incomplete command…"`.
  - **Paquetes partidos:** con `split: true`, cada respuesta se parte en paquetes de 100 bytes (incluido un corte a mitad de un carácter UTF-8) y responde al paquete centinela vacío tipo 0 con el mismo id.
  - **SLP real** (handshake + status request + ping), con JSON `{ version:{name:'Paper 1.21.4',protocol:769}, players:{online:2,max:20,sample:[...]}, description:{text:'A ',extra:[{text:'Craft',color:'green'}]} }`.
  - `scripts/dev-fake-server.js` lo arranca en 25575/25565 con la clave `dev` para desarrollar la UI.

- [ ] **Step 1: Test que falla:** un socket TCP crudo hace auth con la clave buena y recibe un paquete con `id` igual al enviado; con la clave mala recibe `id === -1`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `test: fake Minecraft RCON+SLP server`.

### Tarea 7: Cliente RCON

**Files:**
- Create: `src/minecraft/rcon.js`, `test/rcon.test.js`

**Interfaces:**
- Produces:
  - `class RconError extends Error { code: 'ECONNREFUSED'|'ETIMEDOUT'|'EHOSTUNREACH'|'ENOTFOUND'|'AUTH_FAILED'|'CLOSED'|'TIMEOUT' }`.
  - `class RconClient extends EventEmitter`:
    - `constructor({ host, port, password, timeoutMs = 5000 })`.
    - `connect(): Promise<void>`: conecta y autentica.
    - `exec(cmd): Promise<string>`.
    - `close()`.
    - Emite `'close'`.
- **Formato de paquete:** `int32LE length | int32LE id | int32LE type | body UTF-8 | 0x00 0x00`. El ID va incremental.
- **Algoritmo de respuesta completa:** tras el paquete del comando (tipo 2, id N) se envía un centinela tipo 0 vacío con id N+1. Se acumulan los **bytes** de los cuerpos con id N hasta recibir id N+1, y solo entonces se decodifican como UTF-8. Así no se rompe un carácter partido entre paquetes. Un buffer de lectura acumula por si llegan paquetes incompletos.

- [ ] **Step 1: Tests que fallan** contra `startFakeMinecraft`:
  - `exec('list')` devuelve el texto default.
  - Clave mala → `RconError` con `code 'AUTH_FAILED'`.
  - Puerto cerrado → `code 'ECONNREFUSED'`.
  - Con `split: true` y un handler que devuelve `'¡Hola, señores! ' + 'ñ'.repeat(300)`, `exec` devuelve exactamente esa cadena.
  - Un handler que nunca responde → `code 'TIMEOUT'` antes de `timeoutMs + 200`.
  - `exec('say ¡Hola!')` → el fake recibió `'say ¡Hola!'`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar con `node:net`.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(minecraft): RCON client with fragmented response handling`.

### Tarea 8: Conexión persistente con cola y reconexión

**Files:**
- Create: `src/minecraft/connection.js`, `test/connection.test.js`

**Interfaces:**
- Consumes: `RconClient`, `RconError`.
- Produces:
  - `class ServerConnection`:
    - `constructor({ host, port, password, timeoutMs = 5000 })`.
    - `exec(cmd): Promise<string>`: conecta si hace falta. Los comandos entran en una cola FIFO y se ejecutan **de uno en uno**.
    - `close()`.
    - `get state(): 'idle'|'connecting'|'ready'|'error'`.
  - Si se cae la conexión, el comando en vuelo falla con `RconError('CLOSED')` y el siguiente `exec` reconecta. Tras un fallo de conexión, espera 1 s antes del siguiente intento (2 s, 4 s… hasta 30 s). `exec` durante esa espera falla rápido con el último error.
  - `class ConnectionManager`:
    - `constructor(resolveServer: (id) => { host, rcon_port, password })`.
    - `get(id) -> ServerConnection`: lazy, cacheado.
    - `invalidate(id)`: cierra y olvida; se usa al editar o borrar.
    - `closeAll()`.

- [ ] **Step 1: Tests que fallan:**
  - 10 `exec` simultáneos con handlers de latencia aleatoria → cada promesa recibe su propia respuesta y el fake las recibió en orden.
  - `dropConnections()` con un comando en vuelo → ese comando falla con `'CLOSED'` y el siguiente `exec('list')` funciona (reconexión).
  - `invalidate` y luego `get` → instancia nueva.
  - `exec('say ¡Hola, señores!')` dos veces sobre la misma conexión → el fake recibe ambas cadenas intactas.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(minecraft): persistent per-server connection with queue and reconnect`.

### Tarea 9: Server List Ping

**Files:**
- Create: `src/minecraft/ping.js`, `test/ping.test.js`

**Interfaces:**
- Produces:
  - `serverListPing({ host, port = 25565, timeoutMs = 3000 }) -> Promise<{ online: true, version, protocol, software, players: { online, max, sample: string[] }, motd: string, latencyMs }>`. Nunca lanza: si falla, devuelve `{ online: false, error: code }`.
  - `componentToLegacy(component: string|object) -> string`: convierte un componente de texto de Minecraft a una cadena con códigos `§`, incluidos colores con nombre, `bold`/`italic`/`underlined`/`strikethrough`/`obfuscated` y `extra` recursivo. Los colores hex `#rrggbb` se convierten en `§x§r§r§g§g§b§b`.
  - `detectSoftware(versionName) -> 'Paper'|'Purpur'|'Spigot'|'Fabric'|'Forge'|'Vanilla'`: por prefijo o subcadena, sin distinguir mayúsculas.
- Protocolo: handshake con protocolo `-1`, next state 1; status request; respuesta en JSON; ping/pong con `Date.now()` para medir la latencia. Usa VarInt.

- [ ] **Step 1: Tests que fallan:**
  - Contra el fake: `online: true`, `software 'Paper'`, `players.online 2`, `motd === 'A §aCraft'`.
  - Puerto sin servidor → `{ online: false }` en menos de 3.5 s.
  - Host `nonexistent.invalid` → `{ online: false, error: 'ENOTFOUND' }`.
  - `componentToLegacy({ text:'x', bold:true, color:'red' })` → `'§c§lx'`.
  - `componentToLegacy('§aHi')` → `'§aHi'`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(minecraft): server list ping and text component conversion`.

### Tarea 10: Parsers de respuestas y texto con colores

**Files:**
- Create: `src/minecraft/parsers.js`, `src/minecraft/validate.js`, `public/js/lib/mctext.js`, `public/js/lib/names.js`, `test/parsers.test.js`, `test/mctext.test.js`

**Interfaces:**
- Produces (`mctext.js` es un módulo ES puro, que importan el backend y el frontend):
  - `stripCodes(s) -> string`: quita `§x` y `&x` (x ∈ `0-9a-fk-or`, y también `§x§r§r...`).
  - `parseLegacy(s, { ampersand = false }) -> Array<{ text, color: string|null /*hex*/, bold, italic, underline, strike, obfuscated }>`. Usa los colores estándar de Minecraft (`0`=#000000 … `f`=#FFFFFF); `§r` reinicia el formato.
- Produces (`parsers.js`; todos reciben el texto crudo y aplican `stripCodes` antes):
  - `parseList(t) -> { online, max, players: string[] } | { raw }`. Formatos:
    - `"There are 2 of a max of 20 players online: Steve, Alex"`
    - `"There are 0 of a max of 20 players online:"`
    - `"There are 2/20 players online:Steve, Alex"` (formato antiguo)
    - Paper con el prefijo `"default: "` por grupo.
  - `parseBanlist(t) -> { entries: [{ target, source, reason }] } | { raw }`. `"There are no bans"` → `entries: []`. Acepta líneas separadas por `\n` **y también concatenadas sin separador** (RCON vanilla las une): `"There are 2 ban(s):Steve was banned by Server: GriefingAlex was banned by Dami: Spam"`.
  - `parseWhitelist(t) -> { players } | { raw }`: `"There are 2 whitelisted player(s): a, b"` / `"There are no whitelisted players"`.
  - `parseTps(t) -> [n1, n5, n15] | null`: quita el `*`.
  - `parseGamerule(t) -> { name, value: string } | null`: `"Gamerule keepInventory is currently set to: false"`.
- Produces (`public/js/lib/names.js`, módulo ES puro compartido):
  - `isValidPlayerName(n) -> boolean`: `/^[A-Za-z0-9_]{1,16}$/`.
  - `oneLine(s) -> string`: reemplaza cada secuencia de `\r`/`\n` por un espacio y quita `\0`.
- Produces (`validate.js`):
  - `validateCommand(cmd) -> { ok: true, command } | { ok: false, error: 'empty'|'invalid_chars'|'too_long' }`: trim, quita una `/` inicial, rechaza `\r`, `\n` y `\0`, y máximo 1446 bytes UTF-8.
  - Reexporta `isValidPlayerName` desde `../../public/js/lib/names.js`.

- [ ] **Step 1: Tests que fallan:** una tabla de casos con cada formato anterior y su resultado esperado, más:
  - `parseList('basura')` → `{ raw: 'basura' }`.
  - `parseTps('§6TPS from last 1m, 5m, 15m: §a20.0, §a*20.0, §a19.97')` → `[20, 20, 19.97]`.
  - `validateCommand('/say hola')` → `'say hola'`.
  - `validateCommand('say a\nstop')` → `'invalid_chars'`.
  - `validateCommand('x'.repeat(1447))` → `'too_long'`.
  - `parseLegacy('§aHi §lB§rC')` → 3 segmentos con el color y el estilo correctos.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(minecraft): response parsers, color text and command validation`.

---

## Fase 3 — API del backend

### Tarea 11: Gestión de servidores (CRUD + probar conexión)

**Files:**
- Create: `src/services/servers.js`, `src/routes/servers.js`, `test/servers.test.js`
- Modify: `src/app.js`, `src/server.js` (cablear key, manager y servicios)

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret`, `ConnectionManager`, `audit`.
- Produces:
  - `createServers(db, key) -> { list(), get(id), create(input), update(id, input), remove(id), credentials(id) -> { host, rcon_port, password } }`. Ni `list` ni `get` devuelven **nunca** `rcon_password_enc`.
  - Formato público: `{ id, name, host, rconPort, gamePort, icon, color }`.
  - `icon` ∈ `['mountain','sparkle','sword','castle','tree','fire','diamond','skull']`; `color` ∈ `['emerald','violet','amber','sky','rose','slate']`.
  - Rutas:
    - `GET /api/servers`
    - `POST /api/servers` (password obligatorio)
    - `PUT /api/servers/:id`: password opcional; vacío o ausente = sin cambios.
    - `DELETE /api/servers/:id`: hace `manager.invalidate`.
    - `POST /api/servers/test { host, rconPort, password?, id? }`: si falta `password` y llega `id`, usa la guardada. Responde `{ ok: true, latencyMs }` o `{ ok: false, error: code }`, con `code` de `RconError`.
  - Validación: nombre de 1–32 caracteres y único (`409 { error: 'name_taken' }`), puertos 1–65535, host no vacío. Errores en `400 { error: 'validation', fields: {...} }`.
  - Audit `origin 'ui'`, acciones `server_create` / `server_update` / `server_delete`. En `server_delete` la fila queda con `server_id NULL` y el nombre en `detail`.

- [ ] **Step 1: Tests que fallan:**
  - Crear y luego `GET` → el JSON no contiene la contraseña (`assert.ok(!JSON.stringify(body).includes('secretpw'))`) ni `rcon_password_enc`.
  - Nombre duplicado (sin distinguir mayúsculas) → 409.
  - `PUT` sin password conserva la anterior (comprobado con `credentials(id)`); con una nueva, la reemplaza.
  - `DELETE` → 204 y borrado en cascada.
  - `test` contra el fake → `ok: true`; con clave mala → `error 'AUTH_FAILED'`.
  - Sin sesión → 401.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): server CRUD with encrypted RCON passwords and connection test`.

### Tarea 12: Ejecución de comandos, historial, favoritos y stream en vivo

**Files:**
- Create: `src/services/commands.js`, `src/services/hub.js`, `src/routes/console.js`, `src/routes/live.js`, `test/console.test.js`

**Interfaces:**
- Consumes: `ConnectionManager`, `validateCommand`, `audit`.
- Produces:
  - `createHub() -> { subscribe(serverId, socket), unsubscribe(socket), publish(serverId, message), subscribedServerIds(): number[] }`.
  - `createCommands({ db, manager, audit, hub }) -> { run(serverId, command, { origin, audit = true, publish = true }) -> Promise<{ ok, output, error, durationMs, ts }> }`. Las lecturas automáticas (estado, TPS, listas, gamerules) usan siempre `{ origin: 'ui', audit: false, publish: false }` para no llenar la consola ni el registro:
    1. Valida el comando.
    2. Lo ejecuta.
    3. Si `origin === 'console'`, lo guarda en el historial y recorta a 200 por servidor.
    4. Si `audit`, lo registra (`action 'command'`, `result` = los primeros 500 caracteres de la salida).
    5. Si `publish`, publica `{ type: 'console', entry: { ts, origin, command, ok, output, error } }`.
  - Rutas:
    - `POST /api/servers/:id/command { command, origin?: 'console'|'ui' } → 200 { ok, output, error, durationMs, ts }`. Un comando inválido → `400 { error }` sin ejecutarse. Un error RCON → `200 { ok:false, error: code }`.
    - `GET /api/servers/:id/history → [{ command, ts }]`, del más reciente al más antiguo.
    - Favoritos: `GET/POST/PUT/DELETE /api/servers/:id/favorites[/:favId]` con `{ label, command, position }`.
    - WebSocket `GET /api/servers/:id/live`, con sesión obligatoria **y la misma verificación de `Origin` que la Tarea 5** (evita el secuestro del WebSocket desde otro sitio): se suscribe al hub del servidor y recibe `console` (y `status` desde la Tarea 13).

- [ ] **Step 1: Tests que fallan:**
  - `command` con `'say a\nstop'` → 400 y el fake **no** recibió nada.
  - `'/list'` → ok y salida del fake.
  - 205 comandos de consola → el historial devuelve 200.
  - `origin 'ui'` no entra en el historial pero sí en audit.
  - Un cliente WS conectado recibe el mensaje `console` del comando.
  - CRUD de favoritos completo.
  - `'say ¡Hola, señores!'` → el fake recibió esa cadena exacta.
  - `run(..., { audit: false, publish: false })` → ni fila en audit ni mensaje WS.
  - Upgrade WS con `Origin: http://evil.test` → rechazado.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): command execution, history, favorites and live stream`.

### Tarea 13: Estado, TPS y muestras de jugadores

**Files:**
- Create: `src/services/status.js`, `src/services/sampler.js`, `src/routes/info.js`, `test/status.test.js`

**Interfaces:**
- Consumes: `serverListPing`, `commands.run`, `parseTps`, `hub`.
- Produces:
  - `createStatus({ servers, manager, ping = serverListPing }) -> { get(serverId) -> Promise<Status> }`, con caché de 5 s por servidor.
  - `Status = { online, version, software, players: { online, max }, motd, latencyMs, tps: number[]|null, tpsSupported: boolean }`.
  - El TPS se consulta con `commands.run(id, 'tps', { origin: 'ui', audit: false, publish: false })`. Si `parseTps` da `null`, el servidor queda marcado como no compatible y no se vuelve a probar hasta que se invalide la conexión.
  - `createSampler({ db, servers, status, intervalMs = 60_000, retentionMs = 7*24*3600e3, hub, now = Date.now }) -> { tick(), start(), stop() }`. `tick` guarda una muestra por servidor online y borra las anteriores a la retención; además publica `{ type:'status', status }` cada 5 s a los servidores con suscriptores del hub (temporizador aparte).
  - Rutas:
    - `GET /api/servers/:id/status → Status`.
    - `GET /api/servers/:id/samples?range=24h|7d → [{ ts, online, max }]`.
    - `GET /api/servers/status → { [id]: { online, players } }`, para las tarjetas de Servers, con pings en paralelo.

- [ ] **Step 1: Tests que fallan:**
  - Con el fake: `status.get` → `online true`, `tps [20,20,19.97]`, `tpsSupported true`.
  - Con un handler `tps` que devuelve `Unknown command` → `tps null`, `tpsSupported false`.
  - Fake con `setOnline(false)` → `online false` y la ruta responde 200 (no 500) en menos de 3.5 s.
  - Con `now` inyectado: muestra de hace 8 días → `tick` la borra.
  - `samples?range=24h` filtra correctamente.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): server status, TPS detection and player samples`.

### Tarea 14: Lecturas de jugadores, moderación y gamerules

**Files:**
- Create: `public/js/data/gamerules.js`, `test/info.test.js`
- Modify: `src/routes/info.js`

**Interfaces:**
- Consumes: `commands.run(..., { origin: 'ui', audit: false, publish: false })` para todas las lecturas, parsers.
- Produces:
  - `GET /api/servers/:id/players → { online, max, players: string[] } | { raw }` (parseList).
  - `GET /api/servers/:id/bans?type=players|ips → { entries } | { raw }` (`banlist players` / `banlist ips`).
  - `GET /api/servers/:id/whitelist → { players } | { raw }`.
  - `GET /api/servers/:id/gamerules → [{ name, type, value }]`.
  - `gamerules.js` exporta `GAMERULES: Array<{ name, alt?: string, type: 'bool'|'int' }>`: lista camelCase de 1.16–1.21 (al menos: `keepInventory`, `doDaylightCycle`, `doWeatherCycle`, `doMobSpawning`, `mobGriefing`, `doFireTick`, `naturalRegeneration`, `doInsomnia`, `doImmediateRespawn`, `announceAdvancements`, `showDeathMessages`, `doEntityDrops`, `doTileDrops`, `fallDamage`, `fireDamage`, `drowningDamage`, `doPatrolSpawning`, `doTraderSpawning`, `forgiveDeadPlayers`, `universalAnger` como `bool`; `randomTickSpeed`, `spawnRadius`, `playersSleepingPercentage`, `maxEntityCramming` como `int`). `alt` lleva el nombre snake_case para versiones que renombraron gamerules.
  - **Cómo se resuelve cada gamerule:** se consulta `gamerule <name>`; si `parseGamerule` falla y existe `alt`, se prueba `alt`; si ambos fallan, se descarta.

- [ ] **Step 1: Tests que fallan** contra el fake:
  - `players` → `['Steve','Alex']`.
  - `bans` con el formato concatenado → 2 entradas.
  - `gamerules` con un fake que solo conoce `keepInventory` y la `alt` de otra → devuelve exactamente esas dos.
  - Ninguna de estas lecturas crea filas en audit ni mensajes en el stream.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): players, bans, whitelist and gamerule reads`.

### Tarea 15: Proxy de cabezas de skin

**Files:**
- Create: `src/services/heads.js`, `src/routes/heads.js`, `public/img/head-fallback.svg`, `test/heads.test.js`

**Interfaces:**
- Produces:
  - `HEAD_SOURCE = (name) => \`https://mc-heads.net/avatar/${name}/32\`` (único lugar donde se define el servicio).
  - `createHeads({ dir, fetchImpl = fetch, ttlMs = 24*3600e3 }) -> { get(name) -> Promise<{ type: 'png'|'fallback', buffer? }> }`. Caché en `dataDir/heads/<lowercase>.png` y timeout de 3 s. Si la descarga falla, responde `fallback`.
  - `GET /api/heads/:name`: `image/png` con `Cache-Control: max-age=86400`; si es `fallback`, envía el SVG. Un nombre inválido → `400`, sin tocar disco ni red.

- [ ] **Step 1: Tests que fallan:**
  - `fetchImpl` simulado: la primera llamada descarga y la segunda sale de caché (un solo fetch).
  - Un `fetchImpl` que lanza error → `fallback`.
  - `../../etc/passwd`, `a`.repeat(17) y `bad name` → 400 sin llamar a `fetchImpl`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. El SVG genérico es una cara pixelada propia, no la skin de Steve.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): cached skin head proxy with fallback`.

### Tarea 16: Tareas programadas

**Files:**
- Create: `src/services/scheduler.js`, `src/routes/tasks.js`, `test/scheduler.test.js`

**Interfaces:**
- Consumes: `commands.run(serverId, cmd, { origin: 'task' })`.
- Produces:
  - `computeNextRun(task, fromMs) -> number`:
    - `interval`: `fromMs + interval_minutes*60e3`.
    - `daily`: la siguiente ocurrencia de `daily_time` (`'HH:MM'`) en la **hora local del proceso**, estrictamente después de `fromMs`.
  - `Step = { type: 'command', command } | { type: 'wait', minutes }`.
  - `createScheduler({ db, commands, now = Date.now, sleep = ms => setTimeout promisified, tickMs = 15_000 }) -> { tick(), start(), stop(), runNow(taskId) }`.
    - `tick` ejecuta cada tarea `enabled` con `next_run_at <= now()` que no esté ya corriendo.
    - Ejecuta los pasos en secuencia; si un comando falla, se registra y sigue.
    - Al empezar, fija `last_run_at`, recalcula `next_run_at` y registra en audit `{ origin: 'task', action: 'task_run', detail: <nombre de la tarea> }`.
    - Al crear o activar una tarea se calcula `next_run_at`.
  - Rutas:
    - `GET/POST/PUT/DELETE /api/servers/:id/tasks[/:taskId]`. Validación: `interval_minutes` entre 1 y 10080; `daily_time` con formato `^\d{2}:\d{2}$` y hora válida; `steps` entre 1 y 50; `wait.minutes` entre 1 y 1440; comandos con `validateCommand`.
    - `POST /api/servers/:id/tasks/:taskId/run`.

- [ ] **Step 1: Tests que fallan:**
  - `computeNextRun` daily `'03:00'` desde las 02:59 locales → las 03:00 del mismo día; desde las 03:00 → las 03:00 del día siguiente.
  - Interval de 30 → `+30 min`.
  - Con `now` y `sleep` falsos, una tarea `[say a, wait 5, say b]` ejecuta los dos comandos en orden con origin `task` y queda en audit.
  - Un segundo `tick` mientras la tarea sigue corriendo no la duplica.
  - Una tarea desactivada no corre.
  - `daily_time '25:00'` → 400.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar y arrancar `scheduler.start()` y `sampler.start()` en `server.js`.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): scheduled tasks with interval and daily triggers`.

### Tarea 17: Settings, actividad y comprobación de versión

**Files:**
- Create: `src/services/updateCheck.js`, `src/routes/settings.js`, `test/settings.test.js`

**Interfaces:**
- Consumes: `settings`, `sessions`, `audit`, `hashPassword`/`verifyPassword`.
- Produces:
  - `POST /api/settings/password { current, next }`:
    - Clave actual mal → `403 { error: 'invalid_password' }`.
    - `next` de menos de 8 caracteres → `400 { error: 'password_too_short' }`.
    - Si todo está bien, cierra todas las sesiones salvo la actual.
  - `GET/PUT /api/settings/dangerous-commands → string[]`, con el default de Global Constraints.
  - `GET /api/activity?serverId=&before=&limit=` → filas de audit (incluye el nombre del servidor).
  - `GET /api/version → { installed, latest: string|null, updateAvailable: boolean }`.
  - `createUpdateCheck({ current, fetchImpl, url = 'https://raw.githubusercontent.com/solqubit/craftrcon/main/VERSION', ttlMs = 6*3600e3 })`: timeout de 3 s. Sin red → `latest: null`. La comparación es semver (función `compareSemver(a,b) -> -1|0|1` en el mismo archivo).
  - Purga diaria de audit > 90 días, añadida al timer del sampler.

- [ ] **Step 1: Tests que fallan:**
  - Cambio de clave con la actual mal → 403; bien → 204, y la sesión anterior de otro cliente da 401.
  - Lista de comandos peligrosos: devuelve el default y se puede actualizar.
  - `compareSemver('0.10.0','0.9.9') === 1`.
  - `fetchImpl` que lanza error → `latest null`, `updateAvailable false`.
  - `activity?serverId=X` filtra por servidor.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): settings, activity log and update check`.

---

## Fase 4 — Interfaz

Verificación común de UI: `npm run fake-mc` en una terminal y `npm run dev` en otra (con `CRAFTRCON_CONFIG` apuntando a un `config.dev.json` ignorado por git). Se agrega el servidor `127.0.0.1:25575` con la clave `dev` y se revisa la pantalla en el navegador, en escritorio (1280 px) y móvil (375 px). Los bocetos aprobados están en `.superpowers/brainstorm/*/content/` (`visual-style.html` opción A, `servers-v2.html`, `console.html`), pero en Console **no** va la pestaña "Live log" (fue eliminada) y en Servers **no** va el campo de ruta de logs.

### Tarea 18: Shell de la SPA, i18n, login y layout

**Files:**
- Create:
  - `scripts/vendor.js`, `public/vendor/htm-preact.js` (generado y commiteado), `public/index.html`, `public/css/app.css`
  - `public/js/{main,api,i18n,router,store}.js`
  - `public/js/components/{Layout,Modal,Confirm,Toast,McText,Head,Empty}.js`
  - `public/js/pages/Login.js`
  - `locales/en.json`, `locales/es.json`
  - `test/i18n.test.js`, `test/locales.test.js`
- Modify: `src/app.js` (`@fastify/static` para `public/` y `locales/`, con fallback a `index.html` en rutas que no empiezan por `/api`)

**Interfaces:**
- Produces:
  - `api.js`:
    - `api(path, { method='GET', body }) -> Promise<json>`: lanza `ApiError { status, code }`. Un 401 dispara `store.set({ authenticated: false })`.
    - `openLive(serverId, onMessage) -> close()`: WebSocket con reconexión cada 3 s.
  - `i18n.js`:
    - `LANGUAGES = [{ code:'en', name:'English' }, { code:'es', name:'Español' }]`: el único lugar para registrar un idioma.
    - `loadLocale(code) -> Promise`.
    - `t(key, vars?) -> string`: interpola `{name}`; si falta la clave, usa `en` y luego la propia clave.
    - `getLang()`/`setLang(code)`: guarda en `localStorage` `craftrcon.lang` con try/catch; default `en`.
  - `router.js`: rutas hash `#/dashboard`, `#/console`, `#/players`, `#/moderation`, `#/world`, `#/tasks`, `#/servers`, `#/settings`.
  - `store.js`: estado global `{ authenticated, servers, activeServerId, lang }`; `activeServerId` se recuerda en `localStorage`.
  - `McText({ text, ampersand })`: pinta `parseLegacy` como `<span>`s con estilo.
  - `Head({ name, size })`: `<img src="/api/heads/<name>">`.
  - `Layout`:
    - Sidebar con logo "⛏ CraftRCON" (con "Craft" en acento), selector de servidor, las 8 secciones con icono SVG inline, el selector EN/ES y la pastilla Online/Offline.
    - Debajo de 768 px la sidebar se convierte en un menú desplegable.
    - Botón "Log out".
  - Login: un campo de clave, un error claro y la cuenta atrás de `retryAfterMs` cuando hay 429.

- [ ] **Step 1: Tests que fallan:**
  - `t` interpola, usa `en` si falta la clave en `es` y devuelve la clave si falta en ambos.
  - `locales.test.js`: `es.json` y `en.json` tienen **exactamente** el mismo conjunto de claves (recorrido recursivo). Este test se vuelve a ejecutar en cada tarea de UI.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. `scripts/vendor.js` copia `node_modules/htm/preact/standalone.module.js` a `public/vendor/htm-preact.js`. `app.css` define los tokens de Global Constraints y los componentes base (botones primario, secundario y peligro; inputs; tarjetas; pills; modal; toast).
- [ ] **Step 4:** `npm test`. Esperado: PASS. **UI:** el login funciona, la clave errónea muestra el error, el cambio EN↔ES se mantiene al recargar, y el menú móvil funciona a 375 px.
- [ ] **Step 5:** Commit `feat(ui): SPA shell, i18n, login and layout`.

### Tarea 19: Página Servers

**Files:**
- Create: `public/js/pages/Servers.js`, `public/js/components/ServerForm.js`
- Modify: `locales/*.json`

**Interfaces:**
- Consumes: `/api/servers*`, `/api/servers/status`.
- Comportamiento (§5.2):
  - Grid de tarjetas con icono y color, estado, jugadores y versión, más los botones Open (selecciona el servidor y va a Dashboard), Edit y Delete. Al final, la tarjeta "+ Add server".
  - **Formulario:**
    - Campos: nombre, host, puerto RCON (25575), contraseña con botón de ojo, puerto del juego (25565), y selector de icono y color.
    - Errores por campo.
    - Al editar, la contraseña aparece vacía con el placeholder `t('servers.passwordUnchanged')`.
    - "Test connection" muestra el resultado traducido por código de error (un mensaje por cada `RconError.code`).
  - **Borrar:** el modal pide escribir el nombre exacto y explica que el servidor de Minecraft no se toca.
  - **Estado vacío:** en Dashboard y en Servers, la bienvenida con "Add server" cuando no hay servidores.

- [ ] **Step 1:** Implementar.
- [ ] **Step 2:** `npm test` (paridad de locales). Esperado: PASS.
- [ ] **Step 3:** **UI:**
  - Crear el servidor contra el fake; editarlo sin cambiar la contraseña y la conexión sigue funcionando.
  - Probar la conexión con una clave mala → mensaje de contraseña incorrecta.
  - Borrar con confirmación.
  - En las respuestas de la pestaña de red no aparece la contraseña.
- [ ] **Step 4:** Commit `feat(ui): server management page`.

### Tarea 20: Página Console y autocompletado

**Files:**
- Create: `public/js/lib/autocomplete.js`, `public/js/data/commands.js`, `public/js/pages/Console.js`, `test/autocomplete.test.js`
- Modify: `locales/*.json`

**Interfaces:**
- Produces:
  - `COMMANDS: Array<{ name, syntax, descKey }>`: todos los comandos vanilla de servidor de 1.16+, con `syntax` como en el juego (p. ej. `gamemode <mode> [player]`) y `descKey` = `cmd.<name>`, con su descripción traducida en los locales.
  - `suggest(input, { commands, players }) -> Array<{ insert, label, detail }>`:
    - Sin espacio: sugiere comandos por prefijo, como máximo 8.
    - Tras el nombre del comando: si el siguiente argumento de la sintaxis es `<player>`/`[player]`/`<target>`/`<targets>`, sugiere jugadores por prefijo y además `@a @p @r @s @e`. Si el argumento es `<mode>`, sugiere `survival creative adventure spectator`.
    - Ignora una `/` inicial.
- Comportamiento (§5.8):
  - **Salida:** líneas con hora; comandos en acento; errores en `--danger`; salida pintada con `McText`. Las entradas de otros orígenes (`task`, `ui`) llegan por WS con una etiqueta pequeña.
  - **Entrada:**
    - `Tab` completa y `↑`/`↓` navegan las sugerencias cuando están abiertas.
    - Con las sugerencias cerradas, `↑`/`↓` recorren el historial.
    - `Enter` envía.
  - **Herramientas:** filtro de texto, exportar `.txt` (`craftrcon-<server>-<fecha>.txt`) y limpiar la pantalla (solo la vista).
  - **Panel lateral:** favoritos (CRUD en un modal y ejecución con un clic) e historial (clic = copiar a la entrada).
  - **Confirmación:** si el comando empieza por alguno de `dangerous-commands` (comparando por palabra completa del prefijo), muestra el modal de confirmación antes de enviar.
  - Nota visible de una línea sobre el límite de RCON (§5.8).

- [ ] **Step 1: Tests que fallan:**
  - `suggest('gam')` → `gamemode` y `gamerule`.
  - `suggest('/gam')` → igual.
  - `suggest('gamemode cr')` → `creative`.
  - `suggest('kick St', { players:['Steve','Alex'] })` → `Steve`.
  - `suggest('tp @')` incluye `@a`.
  - `suggest('')` → `[]`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS. **UI:**
  - Enviar `list` y `say §aHola, señores` y que la salida salga coloreada.
  - Que `stop` pida confirmación.
  - Que el historial sobreviva a una recarga.
  - Que un comando ejecutado desde una tarea aparezca en vivo.
- [ ] **Step 5:** Commit `feat(ui): console with autocomplete, history and favorites`.

### Tarea 21: Página Dashboard

**Files:**
- Create: `public/js/pages/Dashboard.js`, `public/js/components/LineChart.js`
- Modify: `locales/*.json`

**Interfaces:**
- Consumes: `/status`, `/samples`, `/players`, `/command`, `openLive`.
- Comportamiento (§5.3):
  - **Tarjetas:** Players X/Y, TPS (oculta si `tpsSupported === false`; verde ≥ 18, ámbar ≥ 15, rojo < 15), Version + software, y Ping.
  - **MOTD** con `McText`.
  - **`LineChart({ points, height })`:** SVG propio con eje Y entero, tooltip al pasar el ratón y selector 24h/7d.
  - **Mini consola:** las últimas 6 entradas del stream y una entrada rápida.
  - **Lista de jugadores** con `Head`.
  - **Servidor offline:** un estado claro con el último error, sin tarjetas vacías rotas.
  - **Anuncios (§5.7):** aquí va un bloque "Broadcast" que abre el editor de la Tarea 24.

- [ ] **Step 1:** Implementar.
- [ ] **Step 2:** `npm test`. Esperado: PASS.
- [ ] **Step 3:** **UI:**
  - Los datos del fake se ven bien.
  - `setOnline(false)` en el fake → el estado Offline aparece en ≤ 5 s.
  - Con un handler `tps` desconocido, la tarjeta TPS desaparece.
- [ ] **Step 4:** Commit `feat(ui): dashboard with status, chart and mini console`.

### Tarea 22: Página Players

**Files:**
- Create: `public/js/lib/builders.js`, `scripts/gen-items.js`, `public/js/data/items.js` (generado y commiteado), `public/js/pages/Players.js`, `test/builders.test.js`
- Modify: `locales/*.json`

**Interfaces:**
- Consumes: `isValidPlayerName` y `oneLine` de `public/js/lib/names.js` (Tarea 10).
- Produces (`builders.js`, funciones puras que devuelven el comando como cadena; si un nombre no pasa `isValidPlayerName`, lanzan `Error('invalid_player')`):
  - `kick(p, reason?)`
  - `ban(p, reason?)`
  - `banIp(target, reason?)`
  - `pardon(p)`
  - `pardonIp(ip)`
  - `op(p)`
  - `deop(p)`
  - `gamemode(p, mode)`
  - `tpToPlayer(p, target)`
  - `tpToCoords(p, x, y, z)`: números, admite `~`.
  - `give(p, item, count)`: `count` de 1 a 6400 e `item` en `/^[a-z0-9_:.]+$/`.
  - `tell(p, msg)`
  - `whitelistAdd(p)`
  - `whitelistRemove(p)`
  - `whitelistToggle(on)`

  Los motivos y mensajes se pasan por `oneLine`.
- `items.js` exporta `ITEMS: string[]`, generado desde `minecraft-data` con la última versión Java que tenga el paquete.
- Comportamiento (§5.4):
  - Lista con refresco cada 5 s mientras la página está visible.
  - Cada fila: cabeza, nombre y un menú de acciones que abre modales pequeños (motivo, modo, destino o coordenadas, ítem con autocompletado sobre `ITEMS` y cantidad, mensaje).
  - Las acciones peligrosas pasan por la confirmación de la lista configurable.
  - Toast con la respuesta del servidor.

- [ ] **Step 1: Tests que fallan:**
  - `kick('Steve','Griefing\nstop')` → `'kick Steve Griefing stop'`.
  - `give('Steve','diamond_sword',1)` → `'give Steve diamond_sword 1'`.
  - `give('Steve','x',0)` lanza error.
  - `tpToCoords('Steve','~','64','-10')` → `'tp Steve ~ 64 -10'`.
  - `op('../x')` lanza `invalid_player`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS. **UI:** cada acción sobre "Steve" en el fake genera el comando correcto, visible en Console.
- [ ] **Step 5:** Commit `feat(ui): players page with quick actions`.

### Tarea 23: Página Moderation

**Files:**
- Create: `public/js/pages/Moderation.js`
- Modify: `locales/*.json`

**Interfaces:**
- Consumes: `/bans`, `/whitelist`, `builders.js`.
- Comportamiento (§5.5): cuatro pestañas.
  - **Bans:** tabla con jugador, quién baneó y motivo; quitar ban, y agregar con nombre y motivo.
  - **IP bans:** igual que Bans, sobre `/bans?type=ips`.
  - **Whitelist:** lista, agregar, quitar, y un interruptor on/off. Apagarla pide confirmación por estar en la lista de peligrosos.
  - **Ops:** formulario para agregar o quitar, más la línea explicativa de que RCON no permite listar operadores.
  - Si la API devuelve `{ raw }`, se muestra el texto en crudo con `McText`.

- [ ] **Step 1:** Implementar.
- [ ] **Step 2:** `npm test`. Esperado: PASS.
- [ ] **Step 3:** **UI:** las cuatro pestañas funcionan contra el fake, incluido un `banlist` concatenado.
- [ ] **Step 4:** Commit `feat(ui): moderation page`.

### Tarea 24: Página World y editor de anuncios

**Files:**
- Create: `public/js/lib/tellraw.js`, `public/js/pages/World.js`, `public/js/components/Broadcast.js`, `test/tellraw.test.js`
- Modify: `locales/*.json`

**Interfaces:**
- Produces:
  - `segmentsToComponent(segments) -> object`: segmentos de `parseLegacy` → componente de texto.
  - `usesSnbt(version: string) -> boolean`: `true` para Java ≥ 1.21.5, cuando `tellraw` pasó a SNBT. `version` es el `Status.version`, p. ej. `"Paper 1.21.4"` → extraer `1.21.4`. Si no se reconoce la versión → `false`.
  - `buildTellraw(message, { version, target='@a' }) -> string`: `parseLegacy(message, { ampersand:true })` → componente → JSON (`tellraw @a {"text":...}`) o SNBT (`tellraw @a {text:'...',color:'green'}` con las comillas escapadas).
  - `buildSay(message) -> string`: `say ` + `oneLine(message)`.
- Comportamiento:
  - **World (§5.6):**
    - Hora: day/noon/night/midnight y un valor exacto.
    - Clima: clear/rain/thunder.
    - Dificultad, con confirmación.
    - Gamerules: interruptores para los booleanos y campos con botón "Set" para los numéricos, con carga perezosa y estado de carga.
    - Borde del mundo: tamaño y centro.
    - Botón `save-all`.
  - **Broadcast (§5.7):**
    - Textarea con botones de color y formato que insertan códigos `&`.
    - Vista previa con `McText`.
    - Selector "Formatted (tellraw)" o "Simple (say)".
    - El modal se reutiliza en Dashboard.

- [ ] **Step 1: Tests que fallan:**
  - `buildTellraw('&aHola &lmundo', { version:'Paper 1.21.4' })` → JSON válido (`JSON.parse` del argumento tras `@a `) con `color:'green'` y `bold:true` en el segundo segmento.
  - Con `version:'1.21.5'` → empieza con `tellraw @a {` y no es JSON válido, pero contiene `color:'green'`.
  - Un mensaje con `'` y `\n` → escapado o en una sola línea.
  - `usesSnbt('Vanilla 1.20.1') === false`.
- [ ] **Step 2:** `npm test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS. **UI:** los controles generan los comandos correctos en Console y las gamerules se cargan desde el fake.
- [ ] **Step 5:** Commit `feat(ui): world controls and broadcast editor`.

### Tarea 25: Página Tasks

**Files:**
- Create: `public/js/pages/Tasks.js`, `public/js/data/taskTemplates.js`
- Modify: `locales/*.json`

**Interfaces:**
- Consumes: `/api/servers/:id/tasks*`.
- Produces: `TASK_TEMPLATES` con tres plantillas (las etiquetas por i18n):
  - **saveEvery30:** `interval 30`, `[save-all]`.
  - **autoMessage:** `interval 60`, `[say …]`.
  - **restartWarning:** `daily 04:00`, con los pasos `say Server restart in 10 minutes`, wait 5, `say … 5 minutes`, wait 4, `say … 1 minute`, wait 1, `save-all`, `stop`.
- Comportamiento (§5.9):
  - Lista con nombre, disparador legible ("Every 30 min" / "Daily at 04:00"), próxima ejecución, interruptor de activo, y botones run now / edit / delete.
  - Editor con disparador, lista de pasos que se pueden reordenar (subir y bajar), y "+ Command" / "+ Wait".
  - Al crear, se puede partir de una plantilla.
  - Nota visible: las tareas solo corren con el panel en marcha y con la hora del servidor Linux.

- [ ] **Step 1:** Implementar.
- [ ] **Step 2:** `npm test`. Esperado: PASS.
- [ ] **Step 3:** **UI:**
  - Crear una tarea de intervalo de 1 min con `say test`; aparece en Console como origen `task` tras ≤ 75 s.
  - "Run now" funciona.
  - Desactivar la tarea la detiene.
- [ ] **Step 4:** Commit `feat(ui): scheduled tasks page`.

### Tarea 26: Página Settings

**Files:**
- Create: `public/js/pages/Settings.js`
- Modify: `locales/*.json`

**Interfaces:**
- Consumes: `/api/settings/*`, `/api/activity`, `/api/version`.
- Comportamiento (§5.10, §5.11):
  - **Secciones:** Password (actual / nueva / repetir), Language, Dangerous commands (chips que se pueden quitar y añadir, con botón restaurar defaults), Activity y About.
  - **Activity:** tabla paginada (botón "Load more" con `before`) con filtro por servidor; columnas de fecha local, servidor, origen, acción, detalle y ok.
  - **About:** versión instalada. Si `updateAvailable`, un aviso con el comando a ejecutar: `git clone https://github.com/solqubit/craftrcon.git && cd craftrcon && sudo ./update`, con un botón para copiarlo.

- [ ] **Step 1:** Implementar.
- [ ] **Step 2:** `npm test`. Esperado: PASS.
- [ ] **Step 3:** **UI:**
  - Cambiar la clave y volver a entrar con la nueva.
  - Lo hecho en las tareas anteriores aparece en Activity.
  - El filtro por servidor funciona.
- [ ] **Step 4:** Commit `feat(ui): settings, activity and about`.

---

## Fase 5 — Instalador y actualizador

Todos los scripts:
- Usan `set -Eeuo pipefail`.
- Todo mensaje visible usa `msg KEY [args]`, que busca en `MSG_<KEY>` del archivo de idioma (`--lang es` o `CRAFTRCON_LANG`; default `en`) y aplica `printf`.
- Imprimen colores solo si stdout es una TTY.
- Comprueban con `shellcheck` en CI.

### Tarea 27: Arranque, librería común y comparación de versiones

**Files:**
- Create: `install`, `update` (POSIX sh, `chmod +x`), `scripts/lib/common.sh`, `scripts/lib/messages.en.sh`, `scripts/lib/messages.es.sh`, `test/shell/run.sh`, `test/shell/test_common.sh`

**Interfaces:**
- Produces:
  - `install` y `update`:
    - `#!/bin/sh`.
    - Si no hay `bash` y existe `apk`, ejecuta `apk add --no-cache bash` (solo como root; si no, indica cómo hacerlo).
    - Luego `exec bash "$(dirname "$0")/scripts/install.sh" "$@"` (o `update.sh`).
  - `common.sh`:
    - `msg KEY [args...]`
    - `info`, `ok`, `warn` y `die`: `die` sale con 1.
    - `step N TOTAL KEY`
    - `require_root`
    - `detect_arch` → `x64|arm64`, o `die`.
    - `detect_os`: exporta `OS_ID`, `OS_VERSION`, `OS_LIKE`, `PKG` (apt|dnf|yum|zypper|pacman|apk), `INIT` (systemd|openrc) y `LIBC` (glibc|musl).
    - `pkg_install pkgs...`
    - `version_cmp A B` → imprime `-1|0|1` (semver numérico `X.Y.Z`).
    - `read_secret PROMPT_KEY VAR`: sin eco; o desde `CRAFTRCON_PASSWORD` si `NONINTERACTIVE=1`.
    - `ask PROMPT_KEY DEFAULT VAR`
    - `port_in_use PORT`: usa `ss` o, si no, `/proc/net/tcp`.
    - `wait_health URL TIMEOUT_S`: usa curl hasta `"ok":true`.
    - `is_installed`: existe `/opt/craftrcon/installed.json`.
    - `installed_version`
    - Constantes `APP_DIR=/opt/craftrcon/app`, `NODE_DIR=/opt/craftrcon/node`, `DATA_DIR=/var/lib/craftrcon`, `CONF_DIR=/etc/craftrcon`, `SVC=craftrcon`, `SRC_DIR` (raíz de la copia).
  - Los dos archivos de mensajes definen exactamente las mismas variables `MSG_*`.

- [ ] **Step 1: Tests que fallan** (`test_common.sh` con funciones `assert_eq`; `run.sh` ejecuta todos los `test_*.sh` y sale con 1 si algo falla):
  - `version_cmp 1.4.2 1.4.2` → `0`.
  - `version_cmp 0.10.0 0.9.9` → `1`.
  - `version_cmp 1.0.0 1.0.1` → `-1`.
  - `detect_os` con `OS_RELEASE_FILE` apuntando a fixtures de Debian 12, Rocky 9 y Alpine → `PKG` correcto.
  - Paridad de claves `MSG_` entre en y es: `grep -o '^MSG_[A-Z_]*'`, ordenado y comparado.
- [ ] **Step 2:** `npm run test:shell`. Esperado: FAIL.
- [ ] **Step 3:** Implementar (`detect_os` lee `${OS_RELEASE_FILE:-/etc/os-release}`).
- [ ] **Step 4:** `npm run test:shell`. Esperado: PASS. `shellcheck install update scripts/**/*.sh` limpio.
- [ ] **Step 5:** Commit `feat(installer): bootstrap, common shell library and messages`.

### Tarea 28: Flujo de instalación nueva

**Files:**
- Create:
  - `scripts/install.sh`, `scripts/lib/node.sh`, `scripts/lib/service.sh`
  - `scripts/templates/craftrcon.service`, `craftrcon.openrc`, `craftrcon-proxy.service`, `craftrcon-proxy.openrc`, `Caddyfile.tmpl`
  - `test/shell/Dockerfile.debian12` (y `ubuntu24`, `rocky9`, `fedora`), `test/shell/install-in-container.sh`

**Interfaces:**
- Consumes: `common.sh`, `node src/cli.js init|set-password`, `/api/health`.
- Produces:
  - `node.sh` → `ensure_node`:
    - **glibc:** lee `https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt`, descarga `node-vX-linux-<arch>.tar.xz`, verifica el SHA-256 y lo extrae en `NODE_DIR`. No hace nada si ya existe una versión ≥ 22.13.
    - **musl:** `apk add nodejs npm` y comprobar ≥ 22.13; si no, `die` con `MSG_NODE_TOO_OLD_ALPINE`.
    - Exporta `NODE_BIN` y `NPM_BIN`.
  - `service.sh`:
    - `write_service`: unidad systemd con `User=craftrcon`, `Environment=CRAFTRCON_CONFIG=/etc/craftrcon/config.json`, `ExecStart=$NODE_BIN $APP_DIR/src/server.js`, `Restart=on-failure`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/craftrcon`, `ProtectHome=yes`, `PrivateTmp=yes`; o el script OpenRC equivalente.
    - `service_start`, `service_stop`, `service_enable` y `service_disable`.
    - `open_firewall PORTS...`: `ufw allow N/tcp` o `firewall-cmd --permanent --add-port=N/tcp && --reload`, solo si están activos y el usuario acepta.
    - `setup_caddy DOMAIN PORT`: binario oficial de la última release de GitHub, con checksum verificado contra `caddy_<v>_checksums.txt` (sha512), instalado en `/opt/craftrcon/caddy`; servicio `craftrcon-proxy` como usuario `craftrcon` con `AmbientCapabilities=CAP_NET_BIND_SERVICE`; `XDG_DATA_HOME=/var/lib/craftrcon/caddy`.
    - `show_urls PORT DOMAIN`: IP pública con `curl -s --max-time 3 https://api.ipify.org` más las IP locales (`hostname -I` o `ip -4 addr`).
  - **Flujo `install.sh`** (§8.1, en orden):
    1. Si `is_installed`, pasa al menú de la Tarea 29.
    2. `require_root` y comprobaciones de arquitectura, OS e init. Si no es compatible, `die` **antes de cambiar nada**.
    3. `pkg_install` de `curl`, `tar` y `xz` si faltan (git no es necesario).
    4. `ensure_node`.
    5. Preguntas: clave (dos veces, ≥ 8), puerto (8080; si está ocupado, propone el siguiente libre) y dominio opcional (con el aviso de DNS y de los puertos 80/443).
    6. `useradd --system --no-create-home --shell /usr/sbin/nologin craftrcon` (o `adduser -S` en Alpine).
    7. Copia de la aplicación a `APP_DIR` con `tar --exclude=.git --exclude=node_modules --exclude=data --exclude=.superpowers`.
    8. `npm ci --omit=dev`.
    9. Configuración en `/etc/craftrcon/config.json` (`0640 root:craftrcon`): `{ host: domain ? "127.0.0.1" : "0.0.0.0", port, dataDir, domain, trustProxy: !!domain }`.
    10. `cli.js init` y `set-password` como usuario `craftrcon`, con la clave por stdin y nunca en argumentos.
    11. Escribe `installed.json` `{ version, commit|null, installedAt }`.
    12. Servicio y Caddy (si hay dominio).
    13. Firewall: puerto del panel, o 80/443 si hay dominio.
    14. `wait_health` 30 s.
    15. URL final y, si no hay dominio, el aviso de HTTP sin cifrar.
  - `--non-interactive` toma `CRAFTRCON_PASSWORD`, `CRAFTRCON_PORT` y `CRAFTRCON_DOMAIN`. `--no-service` (solo para CI en contenedores sin init) arranca el panel con `nohup` en segundo plano.

- [ ] **Step 1: Test que falla:** `install-in-container.sh <distro>` construye la imagen, copia el repo y ejecuta `./install --non-interactive --no-service` con `CRAFTRCON_PASSWORD=testpass123`. Después `curl /api/health` debe devolver `ok:true`, y `POST /api/login` con `testpass123` debe devolver 204.
- [ ] **Step 2:** Ejecutarlo en `debian12`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Ejecutarlo en `debian12`, `ubuntu24`, `rocky9` y `fedora`. Esperado: PASS en las 4. `shellcheck` limpio.
- [ ] **Step 5:** Verificación manual en un VPS o VM con systemd: `sudo ./install` interactivo, el servicio arranca tras reiniciar la máquina y se muestra la URL correcta.
- [ ] **Step 6:** Commit `feat(installer): fresh install flow with private Node, service and optional HTTPS`.

### Tarea 29: Instalación existente: menú, cambio de clave, reparar y desinstalar

**Files:**
- Modify: `scripts/install.sh`, `scripts/lib/messages.*.sh`, `test/shell/install-in-container.sh`

**Interfaces:**
- Produces (§8.2):
  - **Si ya está instalado:** muestra la versión instalada y la de la copia. Si la copia es más nueva, ofrece "Run ./update now? [Y/n]" (`exec bash scripts/update.sh`). Luego el menú: 1) cambiar clave, 2) reparar servicio, 3) desinstalar, 4) salir.
  - **`--reset-password`:** `read_secret` + `cli.js set-password`; no reinicia el servicio (las sesiones se invalidan en la DB).
  - **Reparar:** `write_service` + `service_enable` + reinicio + `wait_health`.
  - **`--uninstall`:**
    - Detiene y quita servicios.
    - Borra `/opt/craftrcon` y `/etc/craftrcon`.
    - Pregunta "Delete data too?" (default **No**). Si dice que sí, borra `/var/lib/craftrcon` y el usuario.
    - Cierra las reglas de firewall que se abrieron (guardadas en `installed.json.firewall`).

- [ ] **Step 1: Test que falla** (en el contenedor, tras instalar):
  - `./install --reset-password --non-interactive` con `CRAFTRCON_PASSWORD=newpass456` → el login con la clave nueva da 204 y con la vieja 401.
  - `./install --uninstall --non-interactive` → no existe `/opt/craftrcon`, sí existe `/var/lib/craftrcon` (por el default de No).
- [ ] **Step 2:** Ejecutar. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Ejecutar en las 4 distros. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(installer): existing-install menu, password reset, repair and uninstall`.

### Tarea 30: `./update` con respaldo y vuelta atrás automática

**Files:**
- Create: `scripts/update.sh`, `test/shell/update-in-container.sh`

**Interfaces:**
- Consumes: `common.sh`, `ensure_node`, `service_*`, `wait_health`.
- Produces (§8.4, en orden):
  1. `require_root`. Si no está instalado, `die MSG_NOT_INSTALLED` (sugiere `./install`).
  2. `NEW=$(cat "$SRC_DIR/VERSION")`, `OLD=$(installed_version)`, `version_cmp`:
     - `0` → `ok MSG_UP_TO_DATE "$OLD"` ("CraftRCON %s is already up to date") y `exit 0` **sin tocar nada**.
     - `-1` → `die MSG_DOWNGRADE_REFUSED "$OLD" "$NEW"`.
     - `1` → muestra `"$OLD → $NEW"` y confirma (`--yes` la salta).
  3. **Respaldo:** `BK=/var/backups/craftrcon/$(date +%Y%m%d-%H%M%S)-$OLD` (R16). Copia `craftrcon.db*` (con el servicio **detenido**, para que WAL quede consistente), `config.json` e `installed.json`. Conserva los 5 más recientes.
  4. `service_stop`, `mv APP_DIR APP_DIR.prev`, copia la nueva (mismas exclusiones que en la Tarea 28) y `npm ci --omit=dev`.
  5. `ensure_node` (si `package.json` pide una versión mayor que la instalada, la actualiza).
  6. `service_start` + `wait_health 30` y comprobar que `/api/health.version == NEW`.
  7. Si todo va bien: actualiza `installed.json`, `rm -rf APP_DIR.prev` y muestra la versión y la URL.
  8. Si falla en cualquier paso desde el 4, un trap `ERR`:
     - Detiene el servicio.
     - Restaura `APP_DIR.prev` y la DB del respaldo.
     - Arranca el servicio.
     - Muestra `MSG_UPDATE_ROLLED_BACK` con la causa y la ruta del respaldo.
     - Sale con 1.
  - Nunca toca `secret.key`, la clave de acceso ni `config.json`.

- [ ] **Step 1: Tests que fallan** (`update-in-container.sh`):
  1. Instala desde una copia con `VERSION 0.1.0` y crea un servidor vía API.
  2. `./update` desde la misma copia → mensaje de "up to date", sale con 0 y el `mtime` de `APP_DIR` no cambia.
  3. Copia con `VERSION 0.2.0` → `./update --yes` sale con 0, `/api/health.version == 0.2.0` y el servidor creado sigue en `GET /api/servers`.
  4. Copia con `VERSION 0.1.5` → sale con 1 por downgrade.
  5. Copia con `0.3.0` y `src/server.js` roto a propósito → sale con 1, `/api/health.version == 0.2.0` (rollback) y existe el respaldo.
- [ ] **Step 2:** Ejecutar. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Ejecutar en las 4 distros. Esperado: PASS.
- [ ] **Step 5:** Commit `feat(installer): update command with backup and automatic rollback`.

### Tarea 31: CI y documentación

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `README.es.md`, `CONTRIBUTING.md`

**Interfaces:**
- **CI** (en `pull_request` y `push` a `main`):
  - Job `test`: Node 22.13 y 24 → `npm ci && npm test`.
  - Job `shell`: `shellcheck` + `npm run test:shell`.
  - Job `install`: matriz `debian12, ubuntu24, rocky9, fedora` → `install-in-container.sh` + `update-in-container.sh`.
  - Job `version-bump`, solo en PR: falla si `VERSION` del PR ≤ `VERSION` de `origin/main` (usa `version_cmp`).
  - Job `vendored`: `npm run vendor` y `git diff --exit-code public/vendor` (el archivo incluido coincide con el lockfile).
- **README.md** (inglés):
  - Qué es, capturas, requisitos y cómo activar RCON en `server.properties` (`enable-rcon=true`, `rcon.port`, `rcon.password`).
  - Instalación (`git clone` + `sudo ./install`), actualización (`./update`), cambio de clave y desinstalación.
  - Una sección de seguridad que dice con honestidad qué protege el cifrado (§7).
  - Qué limita RCON (sin chat ni lista de ops).
  - Licencia MIT.
- **README.es.md:** la misma información en español.
- **CONTRIBUTING.md:** cómo agregar un idioma (copiar `locales/en.json`, registrarlo en `LANGUAGES`, `messages.<lang>.sh`), y la regla de subir `VERSION` en cada PR.

- [ ] **Step 1:** Escribir `ci.yml` y empujar a una rama. Esperado: todos los jobs en verde, y un PR sin subir `VERSION` falla `version-bump`.
- [ ] **Step 2:** Escribir los README y CONTRIBUTING. Comprobar que cada comando citado existe y funciona igual que en el instalador.
- [ ] **Step 3:** Commit `chore: CI pipeline and documentation`.
