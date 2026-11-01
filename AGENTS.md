# Instrucciones para trabajar en Mind 1.0

- Construir desde cero usando `docs/Concepto_Mind.pdf` como referencia conceptual.
- No importar código, pruebas, estructuras ni configuraciones de versiones anteriores.
- No implementar funciones fuera del incremento solicitado.
- Mantener la Base de pruebas fuera del repositorio y separada de la instalación personal.
- Usar únicamente datos ficticios en las pruebas y no versionar credenciales ni datos personales.
- Conservar intactos los respaldos históricos.
- Trabajar mediante ramas y pull requests; indicar qué se comprobó y qué queda pendiente.

## Uso selectivo de Mind

Mind es opcional. Los agentes pueden utilizarlo cuando aporte valor y recurrir
directamente a otras herramientas cuando sea suficiente, respetando siempre las
autorizaciones aplicables. Usar otra herramienta no amplía los permisos del agente.
No construir un gestor adicional para aplicar esta decisión.

## Lectura de originales

- El anfitrión de confianza conserva la API administrativa. Solo él concede un
  permiso de lectura tras una autorización explícita del usuario.
- Un agente recibe únicamente su función de lectura ligada a su identidad opaca
  y el permiso para el archivo concreto; no la instancia administrativa del Motor.
- Ni el id de carpeta, ni una ruta, ni un nombre de agente constituyen un permiso.
- No sustituir la apertura por descriptores por `checkFolderScope` seguido de una
  apertura convencional. Si falta el auxiliar seguro, denegar la operación.
