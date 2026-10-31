# Interfaces mínimas — Incremento 01

## Contrato ejecutable

Los tipos están documentados mediante JSDoc en `src/motor.js`; no requieren un
compilador ni añaden dependencias.

```js
import { openMotor } from 'mind-motor';

// Base existente y absoluta, independiente del directorio del Motor.
const motor = await openMotor({ baseDirectory: rutaAbsoluta });
await motor.writeRecord('prueba', 'texto ficticio');
const record = await motor.readRecord('prueba');
```

| Interfaz | Entrada | Resultado |
|---|---|---|
| `openMotor(options)` | `MotorOptions = { baseDirectory: string }` | `Promise<Motor>` |
| `Motor.baseDirectory` | — | Ruta física de la Base externa |
| `Motor.writeRecord(id, value)` | Identificador válido y texto | `Promise<TechnicalRecord>` |
| `Motor.readRecord(id)` | Identificador válido | `Promise<TechnicalRecord \| null>` |
| `TechnicalRecord` | — | `{ id: string, value: string }` |
| `MotorError` | — | Error con `code` estable y mensaje sin contenido del registro |

Abrir no crea archivos. Cada operación espera a terminar su E/S antes de resolver.
No existe `close()`: el núcleo no mantiene recursos abiertos ni un proceso residente.
Una llamada exitosa a `writeRecord` ha escrito y publicado el registro en la Base;
leer desde otra instancia/proceso no necesita estado en memoria de la anterior.

Errores propios: `INVALID_BASE`, `BASE_NOT_FOUND`, `BASE_OVERLAPS_MOTOR`,
`INVALID_ID`, `INVALID_VALUE`, `RECORD_LINK`, `RECORD_CORRUPT`.
La CLI añade `INVALID_ARGUMENTS`. Los errores de E/S mantienen el código del sistema.

## Incorporación posterior de las cinco capacidades

La frontera común es una operación asíncrona que recibe una instancia `Motor`
y la petición propia de su capacidad, y devuelve un resultado. Esta frontera no
requiere registro de plugins, servidor, objetos de dominio ni cinco métodos vacíos.
Los futuros módulos podrán utilizar el contexto explícito del Motor; no deben
suponer una Base global o escribir datos técnicos dentro del código.

| Capacidad conceptual | Entrada de su futura interfaz | Resultado esperado |
|---|---|---|
| Indexar | Rutas autorizadas y alcance de la operación | Registros de índice en la Base |
| Encontrar y acceder | Criterio de búsqueda y alcance autorizado | Localizadores o información solicitada |
| Crear, modificar y organizar | Operación y destinos autorizados | Resultado de la operación y actualización de registros |
| Gestionar funciones | Definición o invocación de una función | Registro o resultado de ejecución |
| Dar continuidad | Información de un trabajo o petición de recuperación | Contexto recuperable o exportable |

Estas filas fijan límites de integración, no implementan ni congelan los contratos
particulares. Autorizaciones, acceso a originales, índices, planificación y formato
de continuidad requieren incrementos aprobados por separado. El almacenamiento de
texto de este núcleo no pretende resolver por adelantado sus necesidades.
