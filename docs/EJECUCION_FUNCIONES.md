# Función 04 — Primera ejecución manual

Este incremento permite que el anfitrión de confianza ejecute manualmente una
función registrada mediante un ejecutor que él mismo proporciona. El módulo
interno `src/function-runner.js` reutiliza el registro de `src/functions.js` y
la misma Base. `openMotor` lo crea con el catálogo `functionExecutors` que entrega
el anfitrión y expone sus operaciones (véase [INTERFACES.md](INTERFACES.md));
no está en la CLI.
No añade dependencias, procesos residentes, horarios ni eventos.

## Dos piezas distintas

| | Definición persistente | Ejecutor de confianza |
|---|---|---|
| Dónde vive | Base, `function-definition-<id>.json` | Código del anfitrión, en memoria |
| Quién la decide | Agente o usuario, mediante el registro | Anfitrión, al crear el ejecutor |
| Qué es | Datos JSON opacos | Funciones `validateInput` y `run` |
| Qué concede | Nada | Solo lo que el anfitrión le entrega en cada invocación |

La definición nunca se interpreta como código: no se usa `eval`, `Function`,
`vm`, importaciones dinámicas ni procesos a partir de su contenido. Un campo como
`executor`, `handler`, `code`, `permissions` o `capabilities` dentro de la
definición es un dato más; no elige ejecutor ni concede permisos.

## Contrato interno

```js
import { openMotor } from '../src/motor.js';
import { createFunctionRegistry } from '../src/functions.js';
import { createFunctionRunner } from '../src/function-runner.js';

const motor = await openMotor({ baseDirectory: rutaAbsolutaDeBaseExistente });
const functions = createFunctionRegistry(motor);
const runner = createFunctionRunner({
  functions,
  executors: {
    'contar-palabras': {
      validateInput: (input) => typeof input?.text === 'string' && input.text.length <= 1000,
      acceptsDefinition: (definition) => Number.isInteger(definition.parameters?.maxWords),
      run: ({ input, definition }) => ({ count: input.text.split(/\s+/u).filter(Boolean).length }),
    },
  },
});

const binding = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
const { result } = await runner.runFunction({ binding, input: { text: 'Texto ficticio' } });
```

| Operación | Resultado |
|---|---|
| `createFunctionRunner({ functions, executors })` | Ejecutor manual con catálogo fijo |
| `bindFunction({ functionId, executor })` | Vínculo opaco ligado a la definición actual exacta |
| `unbindFunction(binding)` | `true` si retiró un vínculo vigente, `false` en otro caso |
| `runFunction({ binding, input, capabilities })` | `{ functionId, executor, result }` |

### Catálogo de ejecutores

Cada ejecutor se identifica con el mismo formato que los ids de función y
declara:

- `validateInput(input, definition)`: obligatorio y síncrono; solo `true` acepta.
- `run({ input, definition, capabilities, signal })`: obligatorio; puede ser asíncrono.
- `acceptsDefinition(definition)`: opcional y síncrono; se consulta al vincular.
- `timeoutMs`: de 1 a 60 000; 10 000 por omisión.
- `maxResultBytes`: de 1 a 65 536; 65 536 por omisión.
- `capabilities`: nombres de las capacidades que puede recibir; ninguna por omisión.

El catálogo se copia al crear el ejecutor manual: añadir o sustituir después
funciones en el objeto del anfitrión no cambia lo autorizado. No existe una
estructura común obligatoria para las definiciones: cada ejecutor decide, con
`acceptsDefinition` y `validateInput`, qué datos admite.

### Vínculo y ejecución

`bindFunction` es la autorización explícita del anfitrión. Registrar o actualizar
una función no crea vínculos. El vínculo es un objeto opaco, como los permisos de
lectura existentes; ni el id de función, ni el nombre del ejecutor, ni un objeto
con esos campos lo sustituyen. Un vínculo vale solo para el ejecutor manual que
lo creó y se pierde al terminar el proceso.

El vínculo guarda la generación UUID persistente y la huella SHA-256 de la
definición aprobada. Cada creación y actualización cambia la generación, incluso
con datos idénticos. Retirar/recrear y A → B → A invalidan el vínculo antiguo
sin necesidad de ejecutar entre los cambios. En cada ejecución:

1. Se comprueba que el vínculo sigue vigente, antes de cualquier E/S.
2. La entrada debe ser un dato JSON (mismas reglas que las definiciones, ahora
   también texto, número, booleano, `null` o array) y ocupar como máximo 64 KiB.
3. Se vuelven a leer conjuntamente generación y definición. Si fue retirada
   (`FUNCTION_NOT_FOUND`), cambió la generación o difiere la huella
   (`FUNCTION_CHANGED`), el vínculo queda retirado y hace falta otro
   `bindFunction`, aunque luego se restaure el mismo contenido. No basta
   con que coincida una de las dos comprobaciones.
4. `validateInput` debe devolver `true`.
5. `run` recibe entrada y definición como copias congeladas, las capacidades
   de esta invocación y un `AbortSignal`.
6. El resultado debe ser un dato JSON dentro del límite del ejecutor. Se entrega
   una copia sin referencias compartidas.

La ejecución no escribe en la Base. Cada `runFunction` es una invocación manual
del anfitrión; un vínculo puede reutilizarse mientras la definición no cambie.

Los registros heredados v1 siguen siendo legibles con el contrato normal
`{ id, definition }`, pero no tienen identidad suficiente para vincularse.
`bindFunction` falla con `FUNCTION_GENERATION_REQUIRED` sin escribir en la Base.
El anfitrión debe actualizar explícitamente la definición (puede conservar sus
datos) para publicar v2 y luego autorizar un vínculo nuevo.

## Capacidades y archivos

Las capacidades son proporcionadas por Mind/el anfitrión en cada invocación y
están separadas del contenido de la definición. Solo se admiten las declaradas
por el ejecutor; por omisión el ejecutor recibe un objeto vacío. El ejecutor
manual no entrega la instancia del Motor ni el registro de funciones.

Registrar o vincular una función no concede acceso a archivos. Para leer un
original, el anfitrión concede primero un permiso con `grantTextRead` y entrega,
como capacidad de esa invocación, una función que use ese permiso. Se conservan
el lector seguro y sus reglas: un permiso por solicitante y archivo, de un solo
intento, invalidado si la carpeta se retira.

## Errores

Propios: `INVALID_FUNCTION_REGISTRY`, `INVALID_EXECUTOR`, `EXECUTOR_NOT_FOUND`,
`FUNCTION_DEFINITION_REJECTED`, `FUNCTION_NOT_BOUND`, `FUNCTION_NOT_FOUND`,
`FUNCTION_CHANGED`, `FUNCTION_GENERATION_REQUIRED`, `INVALID_FUNCTION_INPUT`, `INVALID_CAPABILITIES`,
`FUNCTION_FAILED`, `FUNCTION_TIMEOUT`, `FUNCTION_RESULT_INVALID` y
`FUNCTION_RESULT_TOO_LARGE`. Del registro se conservan `INVALID_FUNCTION_ID`,
`FUNCTION_CORRUPT`, `RECORD_CORRUPT` y `RECORD_LINK`.

Los mensajes no incluyen entrada, definición ni resultado. Cuando el ejecutor
falla, el error original queda en `cause` para el anfitrión, que no debe
reenviarlo a un agente sin revisarlo.

## Límites

- Los ejecutores corren en el proceso del anfitrión: son código de confianza.
  El tiempo máximo rechaza la invocación y activa `signal`, pero no interrumpe
  código síncrono ni deshace efectos ya producidos. Mind no los aísla del sistema.
- Los vínculos están en memoria. La generación es persistente y los antiguos
  no recuperan validez mediante creación/actualización normales. La Base sigue
  siendo de confianza: restaurar manualmente un registro con su UUID anterior
  no equivale a crear una versión nueva mediante la API.
- La revocación se comprueba con el registro releído para cada intento; no hay
  una transacción entre esa comprobación y el despacho del ejecutor. Si el
  registro cambia después de la lectura validada, una invocación ya admitida
  puede comenzar o continuar. Retirar la definición o el vínculo no cancela
  automáticamente una ejecución en curso, no activa su `AbortSignal` ni revierte
  efectos. La prueba con barrera dentro de `run` demuestra que puede terminar;
  los intentos posteriores con el vínculo antiguo se deniegan.
- El anfitrión debe serializar las mutaciones de un mismo id, como en el registro.

## Siguiente paso

Horarios y eventos podrán activar `runFunction` sobre vínculos que el anfitrión
haya aprobado, con este mismo contrato. Quedan pendientes, fuera de este
incremento: persistir aprobaciones, la API pública, la interfaz de aprobación y
las funciones externas con su frontera de confianza.

## Verificación

`node --test test/function-runner.test.js` cubre ejecución válida, entradas no
válidas, función inexistente, retirada y modificada, fallos, tiempo excedido,
resultados no válidos o grandes, ausencia de vínculo, catálogo fijo, contenido
con apariencia de código y separación de capacidades y permisos de lectura,
usando el lector seguro real. Las Bases usan datos ficticios en directorios
temporales hermanos del repositorio.

La corrección de generaciones añade pruebas de retirada/recreación idéntica,
A → B → A sin ejecución intermedia, actualización idéntica, autorización nueva
de B, verificación de huella independiente de la generación, compatibilidad v1
y el límite de revocación durante una ejecución. `test/functions.test.js`
comprueba UUID nuevos, persistencia entre procesos, contrato normal intacto y
rechazo de registros v2 mal formados. Las pruebas de código como datos y de
capacidades del anfitrión se conservan sin añadir ejecutores de producción.
