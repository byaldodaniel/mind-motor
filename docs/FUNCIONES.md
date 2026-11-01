# Función 04 — Registro de definiciones

Este incremento conserva definiciones reutilizables en la misma Base del Motor.
El módulo interno `src/functions.js` todavía no se incorpora a `openMotor`, a la
CLI ni a los exports públicos del paquete. No añade dependencias ni componentes
residentes. No modifica el lector seguro ni la indexación.

## Contrato interno

El anfitrión de confianza entrega el contexto de un Motor ya abierto. La fábrica
comprueba que la ruta sea absoluta; confía en la validación de existencia,
canonicalización e independencia realizada por `openMotor`. No crea ni abre otra
Base y no autentica a agentes. No se debe entregar este módulo administrativo
directamente a un agente como mecanismo de autorización.

```js
import { openMotor } from '../src/motor.js';
import { createFunctionRegistry } from '../src/functions.js';

const motor = await openMotor({ baseDirectory: rutaAbsolutaDeBaseExistente });
const functions = createFunctionRegistry(motor);

await functions.createFunction('resumen', {
  name: 'Resumen ficticio',
  instruction: 'Preparar un resumen del texto recibido como entrada.',
  activation: { type: 'manual' },
});
const definition = await functions.getFunction('resumen');
```

| Operación | Resultado |
|---|---|
| `createFunction(id, definition)` | `{ id, definition }`; rechaza duplicados |
| `getFunction(id)` | `{ id, definition }` o `null` si no existe |
| `listFunctions()` | Definiciones completas ordenadas por id |
| `updateFunction(id, definition)` | `{ id, definition }`; sustituye todo el contenido, exige que exista |
| `retireFunction(id)` | `true` si retiró el registro, `false` si ya estaba ausente |

Los identificadores tienen entre 1 y 64 caracteres, comienzan con letra minúscula
ASCII o número y admiten después minúsculas ASCII, números, guion y guion bajo.
El prefijo del archivo permite ids como `con` sin usar nombres reservados de Windows.

`definition` es un objeto JSON, incluso vacío; no se exige un tipo de ejecutor,
una instrucción ni una lista cerrada de campos. Se admiten objetos y arrays
anidados, texto Unicode, números finitos, booleanos y `null`. Se rechazan ciclos,
funciones JavaScript, getters, `toJSON` ejecutable, `undefined`, símbolos, BigInt,
arrays dispersos o con propiedades adicionales, propiedades ocultas y objetos
de clases como `Date`. Las entradas y salidas no conservan referencias compartidas
con el almacenamiento. Se aplica la representación numérica habitual de JSON.

Los futuros tipos nativo y externo pueden guardar sus propios campos sin cambiar
el envoltorio. Una automatización podrá representarse como una función con sus
datos de activación, por ejemplo `activation`; hoy esos datos son opacos y no
activan horarios ni eventos. Guardar `provider`, código como texto, una ruta o
una referencia externa no ejecuta, importa, abre ni autoriza su contenido.

## Persistencia y retirada

Cada definición ocupa un registro en la raíz de la Base:

```json
{
  "format": "mind-function-definition",
  "version": 2,
  "id": "resumen",
  "generation": "5e0619f7-0a56-43ae-8f67-7b3e38f947a0",
  "definition": { "instruction": "Texto ficticio" }
}
```

Su nombre es `function-definition-<id>.json`. Se reutiliza `storage.js`, incluida
su escritura mediante temporal y publicación por renombrado. No se crea ningún
directorio al construir el módulo, consultar, crear, actualizar o retirar una
definición. Este núcleo no necesita recursos auxiliares; su ubicación se creará
solo cuando una operación futura realmente los necesite.

Cada creación y cada actualización publica un UUID nuevo en `generation`, incluso
si la definición es idéntica a la anterior. La generación pertenece al envoltorio;
un campo del mismo nombre dentro de `definition` sigue siendo un dato opaco.
Las operaciones normales conservan `{ id, definition }`, sin exponer metadatos
adicionales en sus resultados. El ejecutor interno usa `getFunctionVersion(id)`
para leer conjuntamente definición y generación, evitando mezclar dos lecturas.

Los registros v1 (cuatro campos, sin generación) siguen siendo consultables,
listables y retirables. No se migran al leer. Una actualización explícita,
incluso con la misma definición, publica v2 con generación nueva. Vincular un v1
para ejecutar falla con `FUNCTION_GENERATION_REQUIRED` hasta esa actualización;
no se usa una generación nula compartida como identidad de ejecución. Los v2
con generación ausente o mal formada y las versiones desconocidas son corruptos.

Retirar elimina únicamente el registro validado. No borra originales, recursos
ni registros técnicos o autorizaciones. Una definición corrupta no se sobrescribe
al crear o actualizar y no se borra al retirar: requiere reparación explícita fuera
de estas operaciones. No hay migraciones implícitas, caché ni catálogo adicional.

Un listado ignora archivos de otros módulos y temporales. Si encuentra un registro
de función con nombre inválido, JSON inválido, versión desconocida, id discordante
o contenido incorrecto, falla sin entregar una lista parcial. Los enlaces estáticos
se rechazan mediante el almacenamiento existente.

Errores propios: `INVALID_FUNCTION_ID`, `INVALID_FUNCTION_DEFINITION`,
`FUNCTION_EXISTS`, `FUNCTION_NOT_FOUND`, `FUNCTION_CORRUPT` e `INVALID_BASE`.
JSON ilegible conserva `RECORD_CORRUPT`; enlaces conservan `RECORD_LINK`;
otros errores de E/S conservan el código del sistema. Los mensajes propios no
incluyen contenido de las definiciones.

Como en los registros actuales, el anfitrión debe serializar las mutaciones del
mismo id, incluso entre instancias o procesos: no hay bloqueo ni transacciones
entre la consulta previa y la escritura/retirada. Concurrencia sobre ids distintos
es independiente. La Base y el proceso local son confiables; este módulo no
añade aislamiento frente a programas que alteren la Base ni protege carreras
hostiles de sustitución de rutas.

## Verificación

`node --test test/functions.test.js` cubre el ciclo completo, duplicados, ausencia,
reemplazo completo, validación, conservación de datos ante fallos, persistencia de
creación/actualización/retirada entre procesos terminados, independencia de Bases,
consulta entre instancias sin caché, corrupción, enlaces, nombres reservados y
creación simultánea de ids distintos. Las Bases usan datos ficticios y directorios
temporales hermanos del repositorio, separados de la instalación personal.
`npm test` descubre automáticamente estas pruebas junto con las existentes.

Verificación realizada en Windows con Node 24.18.0: 12/12 pruebas propias y
`npm test` completo con 50/50 pruebas de Node y 10/10 del auxiliar nativo. La suite
completa se ejecutó fuera del sandbox: dentro de él, siete pruebas preexistentes
del lector recibieron `ACCESS_DENIED`; no se modificó el lector para eludirlo.

## Pendiente y ejecución manual controlada

Quedan pendientes la conexión a la API pública y el flujo de aprobación. No se
incluyen ejecución, interfaz gráfica, horarios, eventos ni integraciones externas.

Para habilitar después ejecución manual controlada necesitamos acordar:

- Un primer ejecutor de confianza con operaciones permitidas e inputs/resultados
  validados; no interpretar JavaScript o comandos almacenados como código arbitrario.
- Una invocación administrativa explícita del usuario, ligada a la definición exacta
  aprobada (versión o huella), con rechazo si cambia o se retira antes del intento.
- Los recursos y accesos que necesita esa operación. Para originales se conserva
  el lector seguro y sus permisos existentes por solicitante y archivo; una definición
  almacenada no concede acceso ni habilita permisos alternativos.
- Límites de ejecución y tratamiento de fallos/resultados para ese ejecutor. Las
  funciones externas necesitan su frontera de confianza antes de habilitarlas.

Estos son requisitos para un incremento posterior, no capacidades implementadas.
