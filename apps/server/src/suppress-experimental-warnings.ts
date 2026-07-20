/**
 * Suppress the `node:sqlite` ExperimentalWarning that Node emits once
 * the module is first imported. The module is stable enough for our
 * usage and the warning is pure noise on every server startup.
 *
 * Must be imported *before* `node:sqlite` so the patched emitter is in
 * place when the warning would fire.
 */

type EmitFn = (name: string | symbol, ...args: unknown[]) => boolean;

const originalEmit = process.emit.bind(process) as unknown as EmitFn;

const patchedEmit: EmitFn = (name, ...args) => {
  if (name === 'warning') {
    const w = args[0] as { name?: string; message?: string } | undefined;
    if (
      w?.name === 'ExperimentalWarning' &&
      typeof w.message === 'string' &&
      w.message.includes('SQLite')
    ) {
      return false;
    }
  }
  return originalEmit(name, ...args);
};

process.emit = patchedEmit as unknown as typeof process.emit;
