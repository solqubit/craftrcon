#!/usr/bin/env bash
# Mensajes en español del instalador de CraftRCON. Los carga common.sh.
# Cada clave MSG_ debe existir también en messages.en.sh (lo comprueba test/shell/test_common.sh).
# Los valores son formatos de printf: usa %s para argumentos y %% para un signo de porcentaje literal.
# shellcheck disable=SC2034 # las variables se leen de forma indirecta en msg()

MSG_ERR_ROOT='Este comando necesita privilegios de root. Vuelve a ejecutarlo con: sudo %s'
MSG_ERR_ARCH='Arquitectura de CPU no compatible: %s'
MSG_ERR_OS_FILE='No se puede leer el archivo de información del sistema: %s'
MSG_ERR_OS_UNSUPPORTED='Distribución de Linux no compatible: %s'
MSG_ERR_NO_PKG_MANAGER='No se encontró un gestor de paquetes compatible (apt, dnf, yum, zypper, pacman o apk).'
MSG_ERR_NO_CURL='curl es necesario pero no se encontró. Instala curl e inténtalo de nuevo.'
MSG_ERR_VERSION_INVALID='Número de versión no válido: "%s" (se esperaba X.Y.Z)'
MSG_ERR_PASSWORD_MISSING='No se indicó contraseña. Define CRAFTRCON_PASSWORD al ejecutar sin interacción.'
MSG_ERR_BAD_VARNAME='Nombre de variable no válido: %s'
MSG_PKG_INSTALLING='Instalando paquetes del sistema: %s'
