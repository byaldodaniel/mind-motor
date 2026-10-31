import { openMotor, MotorError } from './motor.js';

const usage = `Uso:
  node src/cli.js --base <ruta-absoluta> status
  node src/cli.js --base <ruta-absoluta> write <id> <texto>
  node src/cli.js --base <ruta-absoluta> read <id>
`;

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }
  const [option, baseDirectory, command, ...parameters] = args;
  const counts = { status: 0, write: 2, read: 1 };
  if (option !== '--base' || !Object.hasOwn(counts, command)
      || parameters.length !== counts[command]) {
    throw new MotorError('INVALID_ARGUMENTS', usage.trim());
  }
  const motor = await openMotor({ baseDirectory });
  let result;
  switch (command) {
    case 'status': result = { status: 'ready', baseDirectory: motor.baseDirectory }; break;
    case 'write': result = await motor.writeRecord(...parameters); break;
    case 'read': result = await motor.readRecord(parameters[0]); break;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: {
    code: error.code ?? 'IO_ERROR',
    message: error instanceof MotorError ? error.message : 'No se pudo acceder a la Base.',
  } })}\n`);
  process.exitCode = 1;
}
