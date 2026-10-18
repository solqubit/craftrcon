# CraftRCON — Documento de diseño

Fecha: 2026-10-16
Estado: aprobado
Nombre: **CraftRCON** — "Web RCON panel for Minecraft servers". Repositorio: `solqubit/craftrcon` (el autor renombra `minecraft-rcon-panel`). El identificador técnico es `craftrcon` (carpetas, servicio, usuario de sistema).

Convención: lo marcado **(decisión de Claude)** lo eligió Claude durante el diseño y el autor puede cambiarlo. Lo que no lleva marca lo pidió o aprobó el autor.

---

## 1. Qué es y por qué

Un panel web para administrar uno o varios servidores de Minecraft a través de RCON, con una consola para ejecutar comandos. Debe ser **bonito, intuitivo y fácil de usar sin dejar de ser útil y potente**. Será **de código abierto**.

Se instala en cualquier Linux con `git clone` + `./install`, sin releases ni binarios precompilados. El instalador pide una clave de acceso y al final muestra la URL del panel.

Éxito para el autor:
- Instala en un VPS limpio con dos comandos y entra al panel desde el navegador.
- Hace lo de todos los días (ver quién está, kick/ban, whitelist, clima/hora, avisos, comandos) sin tocar la terminal del servidor.
- Se ve como una herramienta moderna y cuidada, no como un formulario de los 2000.

## 2. Objetivos

1. **Gestión de servidores en el panel:** agregar, editar y eliminar servidores (CRUD) con persistencia. Ningún servidor se configura en el instalador.
2. **Consola** con salida coloreada, autocompletado, historial y favoritos.
3. **Dashboard** por servidor con estado, jugadores, versión, TPS, ping y gráfico de jugadores.
4. **Jugadores, moderación, mundo, anuncios y tareas programadas** (detalle en §5).
5. **Dos idiomas:** inglés (por defecto) y español, preparado para que la comunidad agregue más.
6. **Instalador universal** `./install` para distros basadas en Debian, RPM y otras, más un comando `./update` para actualizar una instalación existente desde una copia nueva del proyecto (§8.4).

### 2.1 Versiones de Minecraft soportadas

- **Conexión:** el protocolo RCON es el mismo en todas las versiones de Java Edition que lo traen. El panel debe **conectarse y ejecutar comandos en cualquier versión** y en cualquier software con RCON: Vanilla, Paper/Spigot/Purpur, Fabric y Forge.
- **Funciones "inteligentes":** autocompletado, IDs de ítems, gamerules, parsers de `list`/`banlist`/`tps`, `tellraw` y los controles de World se diseñan y prueban para **Java 1.16+** **(decisión de Claude)**.
- **Versiones anteriores a 1.16:** la consola y el Dashboard funcionan; si un parser no reconoce una respuesta, la pantalla muestra la respuesta en crudo en vez de fallar.
- **Formato de texto de `tellraw`:** depende de la versión (SNBT en las recientes, JSON en las antiguas). Se elige según la versión que informa el Server List Ping.
- **Fuera:** Bedrock (no tiene RCON) y proxies como Velocity o BungeeCord (no tienen RCON propio).

### 2.2 Actualizaciones

Las instalaciones siguen la **rama `main`** (decidido por el autor): para actualizar se descarga `main` y se ejecuta `./update` (§8.4). Por eso `main` debe estar siempre en estado instalable:
- Los cambios entran por pull request con CI: pruebas y una instalación de prueba en contenedores.
- Las migraciones de base de datos deben poder aplicarse desde cualquier commit anterior de `main`.

## 3. No-objetivos (v1)

- Iniciar, detener o crear procesos del servidor de Minecraft. RCON solo envía comandos; `stop` sí funciona como comando.
- Gestor de archivos, instalador de plugins o mods, ni editor de `server.properties`.
- Backups del mundo.
- Varios usuarios con roles. v1 tiene **una sola clave de administrador**; multiusuario queda como posible mejora futura.
- Releases, paquetes `.deb`/`.rpm` o imágenes Docker.

## 4. Anti-objetivos (sería un fracaso aunque "funcione")

- Que la contraseña RCON llegue alguna vez al navegador.
- Que la instalación requiera pasos manuales previos (instalar Node, compilar, editar archivos) en una distro soportada.
- Que actualizar borre los servidores, favoritos o configuración guardados.
- Que el panel dependa de CDNs o internet para cargar su interfaz. Debe funcionar en una red sin salida, salvo las cabezas de skins, que tienen respaldo (§5.4).
- Interfaz recargada o confusa: cada pantalla tiene un propósito claro.

## 5. Funcionalidades

### 5.1 Navegación y estructura

Barra lateral fija con: logo, **selector de servidor activo**, y las secciones Dashboard, Console, Players, Moderation, World, Tasks, Servers y Settings. El selector cambia el servidor en todas las secciones. Arriba a la derecha van el selector de idioma (EN/ES) y el estado del servidor (Online/Offline).

Responsive: en móvil la barra lateral se vuelve un menú desplegable **(decisión de Claude)**.

### 5.2 Servers (gestión de servidores)

Aprobado con boceto (`servers-v2.html`).

- **Lista de tarjetas:** cada una muestra ícono y color, nombre, dirección, estado (Online/Offline), jugadores, versión y los botones *Open*, *Edit* y *Delete*. Al final va una tarjeta "+ Add server".
- **Formulario de agregar/editar** con estos campos:
  - Nombre (obligatorio, único).
  - Host o IP.
  - Puerto RCON (por defecto 25575).
  - Contraseña RCON.
  - Puerto del juego para el estado (por defecto 25565).
  - Ícono y color (de un set predefinido).
- **Probar conexión:** se conecta por RCON, se autentica, ejecuta `list` y muestra éxito con la latencia, o el error en lenguaje claro (host inalcanzable, puerto cerrado, contraseña incorrecta, RCON desactivado).
- **Editar:** el campo de contraseña llega vacío con el texto "sin cambios". Solo se reemplaza si el usuario escribe una nueva.
- **Eliminar:** el usuario confirma escribiendo el nombre del servidor. Se borra el servidor del panel junto con sus datos asociados (historial, favoritos, tareas, registro). No toca el servidor de Minecraft.
- **Estado vacío:** en un panel sin servidores, el Dashboard muestra una bienvenida con el botón "Add server".

> **Panel independiente (decisión del autor):** el panel funciona aparte del servidor de Minecraft, normalmente en otra máquina, y **solo se comunica por red** (RCON y Server List Ping). No lee archivos del servidor de Minecraft: no hay ruta de logs ni carpeta del servidor. Esto reemplaza el campo "Log file path" del boceto.

### 5.3 Dashboard

Aprobado con boceto (`visual-style.html`, estilo A).

- **Tarjetas:**
  - Jugadores X/Y.
  - TPS: solo en Paper/Spigot/Purpur. Se detecta si el comando `tps` funciona; si no, la tarjeta se oculta.
  - Versión y software.
  - Ping.
- **MOTD** del servidor, con sus colores.
- **Gráfico de jugadores en el tiempo:** últimas 24 h, con opción de 7 días.
- **Mini consola:** las últimas líneas y una caja para comandos rápidos.
- **Lista de jugadores online,** con su cabeza de skin.

Fuentes de datos:
- **Estado, versión, MOTD, jugadores y ping:** vienen del protocolo *Server List Ping* sobre el puerto del juego, sin RCON.
- **Historial de jugadores:** un sondeo periódico del backend lo guarda **(decisión de Claude: cada 60 s, se conserva 7 días)**.

### 5.4 Players

- **Lista de jugadores online:** cabeza, nombre y acciones rápidas:
  - Kick y ban, con motivo.
  - Op y deop.
  - Gamemode.
  - Teleport: a otro jugador o a coordenadas.
  - Give: ítem con autocompletado de IDs y cantidad.
  - Mensaje privado (`tell`).
  - Whitelist add/remove.
- La lista sale de `list` (RCON) y se refresca cada pocos segundos mientras la pantalla está abierta.
- **Cabezas de skin (decisión de Claude):** el **backend** las pide a un servicio público por nombre, las cachea en disco y las sirve al navegador. Si no hay salida a internet, se usa una cabeza genérica. El servicio concreto queda a elección del constructor, y debe poder cambiarse en un solo lugar del código.

### 5.5 Moderation

Pestañas Bans, IP bans, Whitelist y Ops:
- **Bans e IP bans:** listado (de `banlist players` / `banlist ips`), agregar con motivo y quitar (`pardon`, `pardon-ip`).
- **Whitelist:** listado, agregar, quitar, y activar/desactivar (`whitelist on/off`).
- **Ops:** agregar y quitar (`op`, `deop`). RCON vanilla no tiene un comando para listar operadores, así que no hay listado; la pantalla lo explica en una línea.

### 5.6 World

Controles visuales que traducen a comandos:
- **Hora:** botones día, mediodía, noche y medianoche, más un valor exacto.
- **Clima:** despejado, lluvia, tormenta.
- **Dificultad.**
- **Gamerules:** lista con interruptores para los booleanos y campos para los numéricos. Los valores actuales se consultan con `gamerule <regla>`. La lista de gamerules depende de la versión; el constructor elige cómo resolverlo (lista conocida por versión, o consulta y descarte de las que fallan).
- **Borde del mundo:** tamaño y centro.
- **Guardar mundo:** `save-all`.

### 5.7 Anuncios

Dentro de World o como bloque del Dashboard; lo decide el constructor.
- Mensaje a todo el servidor con editor de colores y formato (negrita, cursiva) y vista previa estilo Minecraft.
- Envía vía `tellraw @a` (JSON) o `say`, según elija el usuario.

### 5.8 Console

Aprobado con boceto (`console.html`).

- **Salida:**
  - Cada línea lleva la hora.
  - Tus comandos se muestran en verde y los errores en rojo.
  - Los códigos de color de Minecraft (`§x` y `&x`) se muestran en color.
  - Filtrar, exportar a `.txt` y limpiar.
- **Entrada:**
  - Autocompletado mientras se escribe: comandos vanilla con su sintaxis y una descripción corta traducida, más los nombres de los jugadores online.
  - Se maneja con `Tab`, `↑` y `↓`; `Enter` envía.
  - La `/` inicial es opcional.
- **Historial:** `↑`/`↓` en la caja de texto, más un panel lateral. Se guarda **en el servidor, por servidor de Minecraft** **(decisión de Claude: últimos 200)**.
- **Favoritos:** comandos con nombre, de un clic, con CRUD. Se guardan por servidor.
- **Confirmación de comandos peligrosos:** `stop`, `op`, `deop`, `ban-ip`, `kill @e`, `whitelist off` y `difficulty` (lista editable en Settings) piden confirmación antes de enviarse **(decisión de Claude)**.
- **Límite de RCON (explicado en la interfaz):** RCON solo devuelve la respuesta del comando enviado; el chat y los eventos del servidor no aparecen en la consola. No hay pestaña "Live log" (el boceto la mostraba; se quita por ser el panel independiente).

### 5.9 Tasks (tareas programadas)

- Crear, editar, activar/desactivar y eliminar tareas por servidor.
- **Disparador:** cada N minutos/horas, o a una hora diaria fija **(decisión de Claude: no se exponen expresiones cron en la interfaz, para que sea fácil)**.
- **Acción:** una secuencia de comandos con esperas opcionales entre ellos. Por ejemplo, aviso de reinicio: `say 10 min` → espera 5 min → `say 5 min` → … → `stop`.
- **Plantillas incluidas:** "Guardar cada 30 min", "Mensaje automático" y "Aviso de reinicio".
- Las tareas corren dentro del panel, solo mientras el panel está en marcha, con la zona horaria del servidor Linux. Cada ejecución queda en el registro de acciones.

### 5.10 Registro de acciones (audit log)

Se registra cada comando enviado (desde la consola, un botón o una tarea), con fecha y hora, servidor, origen (consola, interfaz o tarea), comando y resultado resumido. También quedan registrados los inicios de sesión, exitosos y fallidos, y los cambios de servidores.

Se ve en Settings → Activity, con filtro por servidor **(decisión de Claude: se conserva 90 días)**.

### 5.11 Settings

- Cambiar la clave de acceso, pidiendo la actual.
- Idioma: inglés por defecto, se recuerda la elección.
- Lista de comandos que piden confirmación.
- Registro de actividad.
- Información de versión: la versión instalada (archivo `VERSION`, §8.4) y, si hay internet, si en `main` hay una versión más nueva **(decisión de Claude)**. Solo informa; la actualización se hace con `./update`.

### 5.12 Idiomas

- Inglés (por defecto) y español.
- Todas las cadenas de la interfaz viven en archivos de traducción, uno por idioma (p. ej. `locales/en.json`, `locales/es.json`). Agregar un idioma no debe requerir tocar código, salvo registrarlo en una lista.
- Las respuestas del servidor de Minecraft no se traducen; se muestran tal cual.
- La documentación del repo va en inglés, con un `README.es.md` en español **(decisión de Claude)**.

## 6. Estilo visual

Aprobado: **estilo A, "Obsidian"** (`visual-style.html`).

- **Base:** oscuro moderno, con fondo casi negro (`#0b0d10`), paneles `#111418` y bordes sutiles `#1d2228`.
- **Acento:** verde esmeralda (`#34d399`). Rojo (`#f87171`) para peligro y errores; ámbar para avisos.
- **Formas y tipografía:** esquinas redondeadas (7–12 px), fuente del sistema para la interfaz y monoespaciada para consola, IPs y comandos.
- **Comportamiento:** estados vacíos, de carga y de error cuidados en todas las pantallas. Toasts para confirmar acciones. Atajos de teclado en la consola.
- **v1 solo tiene tema oscuro** **(decisión de Claude)**.

Los bocetos están en `.superpowers/brainstorm/` (fuera de git) como referencia.

## 7. Seguridad

Es crítico al ser código abierto y estar expuesto a internet.

- **Acceso:**
  - Una sola clave de administrador, definida en la instalación.
  - Se guarda como hash con **scrypt** (módulo `crypto` de Node, sin dependencias nativas) **(decisión de Claude)**.
- **Sesión:**
  - Cookie `HttpOnly`, `SameSite=Strict`, y `Secure` cuando hay HTTPS.
  - Expira tras 7 días sin uso.
  - Botón "Log out".
- **Fuerza bruta:** límite de intentos de login por IP, con bloqueo temporal progresivo.
- **CSRF:** `SameSite=Strict` más verificación de `Origin` en peticiones que modifican datos.
- **Contraseñas RCON:**
  - Se cifran con AES-256-GCM.
  - La clave de cifrado es un archivo generado en la instalación (permisos `0600`, solo legible por el usuario del servicio).
  - Nunca se devuelven por la API.
  - Esto protege ante fugas de la base de datos o de backups, no ante un atacante con control total de la máquina; el README lo dice con honestidad.
- **El servicio no corre como root:** corre como un usuario de sistema dedicado.
- **Recuperar acceso:** comando de terminal para restablecer la clave (p. ej. `./install --reset-password`).
- **HTTPS:**
  - Sin dominio, el panel corre en HTTP. El instalador **advierte** que la clave viaja sin cifrar y recomienda configurar un dominio con HTTPS.
  - Con dominio, el HTTPS es automático (§8).
- **Comandos:** se envían tal cual escribe el usuario; no hay ejecución en el sistema operativo.

## 8. Instalación (`./install`)

Flujo de uso:

```bash
git clone https://github.com/solqubit/craftrcon.git
cd craftrcon
sudo ./install
```

### 8.1 Qué hace en una instalación nueva

1. **Comprueba el entorno:**
   - Que se ejecuta como root o con sudo.
   - La arquitectura: x86_64 o aarch64.
   - La distro, vía `/etc/os-release`.
   - El gestor de paquetes: `apt`, `dnf`, `yum`, `zypper`, `pacman` o `apk`.
   - El sistema de servicios: systemd u OpenRC.
   - Si algo no es compatible, lo dice claramente y se detiene **antes de cambiar nada**.
2. **Instala solo lo que falte** (`git`, `curl`, `tar`) con el gestor de la distro.
3. **Node.js (decisión de Claude):**
   - El panel requiere Node.js **≥ 22.13** (por `node:sqlite` integrado).
   - En distros glibc, el instalador descarga el binario oficial de nodejs.org, **verifica su SHA-256** con `SHASUMS256.txt` y lo coloca en una carpeta privada del panel. No toca ningún Node del sistema.
   - En Alpine (musl) usa el paquete `nodejs` de `apk` si cumple la versión; si no, lo explica y se detiene.
4. **Pide datos interactivamente**, con valores por defecto:
   - **Clave de acceso:** sin mostrarla en pantalla, dos veces, mínimo 8 caracteres.
   - **Puerto del panel:** por defecto 8080. Si está ocupado, lo avisa y propone uno libre.
   - **Dominio, opcional:** si se indica, configura HTTPS automático (Caddy u otra opción, a elección del constructor) y avisa que el dominio debe apuntar ya a esta IP y que los puertos 80/443 deben estar libres.
5. **Copia la aplicación** a `/opt/craftrcon` (una copia de los archivos, no depende de git). El usuario puede borrar la carpeta desde donde instaló.
6. **Prepara datos y servicio:**
   - Crea el usuario de sistema `craftrcon`.
   - Datos en `/var/lib/craftrcon`: base de datos SQLite, clave de cifrado, caché de cabezas.
   - Configuración en `/etc/craftrcon/config` (o similar).
   - Instala dependencias con `npm ci --omit=dev`.
7. **Crea y arranca el servicio** (unidad systemd o script OpenRC), con arranque automático al iniciar la máquina.
8. **Firewall:** si detecta `ufw` o `firewalld` activos, pregunta si abrir el puerto.
9. **Comprueba** que el panel responde en el puerto.
10. **Muestra la URL**, por ejemplo:
    ```
    ✔ Panel installed!
      Open:  http://203.0.113.10:8080
             http://192.168.1.50:8080 (local network)
    ```
    La IP pública se averigua con un servicio externo de "cuál es mi IP"; si falla, solo muestra las locales. Con dominio, muestra `https://dominio`.

Mensajes del instalador:
- **Idioma:** en inglés por defecto. `./install --lang es` los muestra en español **(decisión de Claude)**.
- **Formato:** claros, con colores y pasos numerados.
- **Errores:** si algo falla, dicen qué falló y qué hacer.

### 8.2 `./install` sobre una instalación existente

Si `./install` encuentra el panel ya instalado, no reinstala a ciegas:

1. Muestra la versión instalada y la versión de la copia desde la que se ejecuta.
2. Si la copia es más nueva, recomienda `./update` y ofrece ejecutarlo ahí mismo.
3. Ofrece además un menú:
   - Cambiar la clave de acceso.
   - Reparar el servicio (volver a crear la unidad systemd/OpenRC y reiniciar).
   - Desinstalar: pregunta si borrar también los datos.
   - Salir.

Atajos no interactivos: `--reset-password` y `--uninstall`.

### 8.3 Distros soportadas

- **Objetivo, probadas:** Debian 12/13, Ubuntu 22.04/24.04, Rocky/Alma 9, Fedora reciente.
- **Mejor esfuerzo:** openSUSE, Arch y Alpine.

### 8.4 `./update`

Pedido por el autor. Sirve para actualizar un panel ya instalado con una copia nueva del proyecto, descargada en cualquier carpeta:

```bash
cd /tmp
git clone https://github.com/solqubit/craftrcon.git
cd craftrcon
sudo ./update
```

**Cómo identifica la versión (decisión de Claude):**
- El repo tiene un archivo **`VERSION`** con un número semver (p. ej. `1.4.2`).
- Cada cambio que entra a `main` sube ese número; un chequeo de CI lo exige.
- Al instalar o actualizar, la versión y el commit (si la copia tiene `.git`) se guardan en `/opt/craftrcon`.
- No depende de git: también funciona con una copia descargada como `.zip`.

**Qué hace:**
1. Comprueba que se ejecuta como root y que el panel está instalado. Si no lo está, lo dice y sugiere `./install`.
2. Compara la versión de la copia con la instalada:
   - **Igual:** dice "CraftRCON 1.4.2 is already up to date", no cambia nada y termina con éxito.
   - **Más nueva:** muestra "1.4.1 → 1.4.2" y pide confirmación (o sigue directo con `--yes`).
   - **Más vieja:** avisa que sería volver atrás y se detiene. Volver atrás puede romper la base de datos; no hay forma de forzarlo en v1.
3. **Respaldo:** copia la base de datos y la configuración a `/var/backups/craftrcon/<fecha>-<versión>/` (fuera de la carpeta de datos, que pertenece al usuario del servicio; ruling R16). Se guardan los últimos 5.
4. Detiene el servicio, reemplaza los archivos de la aplicación en `/opt/craftrcon` con los de la copia y ejecuta `npm ci --omit=dev`.
5. Si la nueva versión exige un Node más nuevo, lo descarga igual que el instalador.
6. Arranca el servicio. Las migraciones de base de datos se aplican solas al arrancar.
7. Comprueba que el panel responde. **Si falla, restaura la versión anterior y el respaldo, vuelve a arrancar y explica qué pasó.**
8. Muestra la versión nueva y la URL del panel.

Nunca toca la clave de acceso, la clave de cifrado, los servidores guardados ni la configuración (puerto, dominio).

## 9. Arquitectura técnica

Todo el apartado es **(decisión de Claude)**.

- **Backend:**
  - Node.js (≥ 22.13), servidor HTTP con un framework ligero (p. ej. Fastify) y WebSocket para la consola y el estado en tiempo real.
  - Cliente RCON y Server List Ping implementados en el propio proyecto. Son protocolos pequeños, y así se controlan timeouts, reconexión y respuestas fragmentadas.
  - **Conexión RCON persistente por servidor,** con cola de comandos (uno a la vez), reconexión automática y timeout por comando.
- **Persistencia:**
  - SQLite con `node:sqlite`, sin dependencias nativas que compilar.
  - Guarda: servidores, favoritos, historial de comandos, tareas, registro de acciones, muestras de jugadores y sesiones.
  - Las migraciones de esquema son versionadas y se aplican al arrancar.
- **Frontend:**
  - Una SPA **sin paso de compilación**: módulos ES nativos más una librería pequeña de UI **incluida en el repositorio** (sin CDN).
  - El constructor elige la librería, que debe ser ligera y no necesitar compilación (p. ej. Preact + htm, o Alpine.js).
  - Los gráficos también, con una librería pequeña incluida o SVG propio.
- **Pruebas:**
  - Runner de pruebas integrado de Node.
  - Un **servidor RCON falso** para probar cliente, cola, reconexión y errores.
  - Pruebas del parser de colores `§`/`&`, de los parsers de respuestas (`list`, `banlist`, `tps`) y de la API.
  - El instalador se prueba en contenedores de las distros objetivo.
- **Licencia:** MIT **(decisión de Claude)**.

## 10. Qué queda a criterio del constructor

- Estructura de carpetas del repo, nombres de rutas de la API y esquema exacto de la base de datos.
- Librería de UI y de gráficos, siempre que no requieran compilación y estén incluidas en el repo.
- Servicio de cabezas de skin y opción de HTTPS automático.
- Cómo resolver la lista de gamerules por versión.
- Dónde se ubican los anuncios (§5.7).
- Íconos, microinteracciones y detalles visuales dentro del estilo Obsidian.

## 11. Pendiente de decidir (autor)

Nada. Nombre, versiones y canal de actualización quedaron definidos.
