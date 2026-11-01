# Integración de indexación, funciones y continuidad

## PR y commits comprobados

Se verificaron los heads contra las tres copias de trabajo terminadas y los
checks de GitHub Actions, sin repetir una auditoría general:

| PR | Head verificado | Commit de integración |
|---|---|---|
| #6 Indexación | dee3fa0e28bd83d21cdab4ffe6433f1f69e018d0 | 2d68110a04bbfa4087d4c4239f62045658e2a8e4 |
| #5 Definiciones de funciones | 2dfc529598122a5c95130be13735bed1a8114d2f | 70fd7441e023dce8f8d0bdf617eaa97b4f6f8f6b |
| #4 Continuidad | 2eeb304b553d4edb63864e56bf1c9cad1a27557a | 730ad7f55d5ed3cadc1120116093dd98264f27b3 |

Los jobs Windows/macOS/Linux estaban aprobados en las ejecuciones
[41327266774](https://github.com/byaldodaniel/mind-motor/actions/runs/41327266774),
[41326811918](https://github.com/byaldodaniel/mind-motor/actions/runs/41326811918) y
[41326706906](https://github.com/byaldodaniel/mind-motor/actions/runs/41326706906),
respectivamente.

## Prueba de la combinación antes de fusionar

Se clonó el repositorio en una copia temporal aislada y se combinaron los heads
exactos, en el orden #6, #5 y #4, sobre main
`d56f9d9a2670cd16d30ea26e9a1f9f9afdfe4199`. No hubo conflictos.
El árbol combinado fue `b6ed70886d2e7e4cd0cfc84bf6ef58763dc25385`.
Tras fusionar secuencialmente en GitHub, main `730ad7f` tenía ese mismo árbol.

Suite completa en Windows, Node 24.18.0 y Python 3.12, con `npm.cmd test`:

- JavaScript: 79 pruebas, 78 aprobadas y 1 omitida (FIFO POSIX).
- Python lectura: 10 aprobadas.
- Python indexación: 12 pruebas, 11 aprobadas y 1 omitida (identidad inode POSIX).
- Cero fallos. Datos ficticios y Bases de pruebas fuera del repositorio.

## Conexión mínima en una PR específica

- `openMotor` crea su indexador con Base física, el mismo intérprete del lector y
  el resolutor privado del registro existente. Solo recibe ids.
- `indexFolder` y `readFolderIndex` quedan disponibles para administración local.
  No se implementan permisos de indexación para agentes ni un sistema paralelo.
- `revokeFolder` revoca primero el registro y después elimina el índice, incluso
  si ya no existe la carpeta original. Si la limpieza falla, se informa sin
  restaurar la autorización.
- El índice v2 conserva `authorizationGeneration` del registro. Los índices v1 o
  de otra concesión se consideran no vigentes; no aportan metadatos antiguos a una
  nueva reconciliación. Se comprueba el vínculo también al terminar el recorrido.
- Continuidad y funciones permanecen internas, sin métodos en Motor ni CLI.
  Ninguna definición de función se ejecuta por esta integración.

Las nueve pruebas de integración comprueban el registro como único origen de
ámbitos, persistencia entre procesos, retirada y limpieza, ausencia de concesión
de lectura implícita, restauración/publicación tardía de índices viejos,
compatibilidad v1, reautorización durante recorrido, fallo de limpieza ante enlace
sin restaurar autoridad y uso del mismo intérprete.

Suite local después de la conexión: JavaScript 88 pruebas, 87 aprobadas y
1 omitida POSIX; Python lectura 10 aprobadas; Python indexación 11 aprobadas y
1 omitida POSIX. Cero fallos. Los checks de la PR específica muestran la
verificación de la conexión en los tres sistemas.

## Límites y siguiente capacidad

El vínculo usa la generación ya existente del registro; no es otro permiso ni una
garantía de aislamiento del SO. Entre procesos no hay transacción para
revocar/publicar: una publicación tardía puede dejar un archivo antiguo en la
Base, pero no se considera vigente ni se entrega bajo otra concesión.
Se conservan los límites del recorrido seguro documentados en INCREMENTO_04.

Un agente real podrá recibir el contenido de un archivo concreto mediante el
adaptador de lectura y la autorización explícita existente. El índice quedará
preparado para una futura búsqueda o selección autorizada, pero esta integración
no concede al agente el catálogo, indexación, continuidad ni ejecución de
funciones. Sus autorizaciones se conectarán por separado.

My Mind y la Base personal no se abrieron ni modificaron. Tampoco se modificaron
las copias de desarrollo de los otros agentes: la conexión se trabajó en el clon
aislado y se presenta mediante su propia rama y PR.
