import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Stable source fingerprint for main-build runner/broker artifacts.
 * Inputs are deliberately repository-relative: root build manifests,
 * every app/package manifest and build config, and every file below
 * each app or package's src directory. Absolute paths, mtimes, node_modules,
 * package-manager stores, tests, docs, and generated dist are absent.
 */
export function sourceFingerprint(repoRoot) {
  const files = [];
  const addTree = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) addTree(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'scripts/source-fingerprint.mjs',
  ]) {
    const full = join(repoRoot, name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {}
  }
  for (const family of ['apps', 'packages']) {
    const root = join(repoRoot, family);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgRoot = join(root, entry.name);
      for (const name of ['package.json', 'tsconfig.json', 'tsup.config.ts', 'vite.config.ts']) {
        const full = join(pkgRoot, name);
        try {
          if (statSync(full).isFile()) files.push(full);
        } catch {}
      }
      try {
        addTree(join(pkgRoot, 'src'));
      } catch {}
    }
  }
  files.sort((a, b) =>
    compareCodeUnits(
      relative(repoRoot, a).split(sep).join('/'),
      relative(repoRoot, b).split(sep).join('/'),
    ),
  );
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(repoRoot, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** Locale-independent UTF-16 code-unit order, matching JavaScript's relational operators. */
export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
