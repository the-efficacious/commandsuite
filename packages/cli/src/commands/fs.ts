import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { link, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Client } from 'csuite-sdk/client';
import type { FsEntry, FsWriteCollisionStrategy } from 'csuite-sdk/types';
import { UsageError } from './errors.js';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

export function inferMimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface UploadLocalFileInput {
  localPath: string;
  path: string;
  mimeType?: string;
  collision?: FsWriteCollisionStrategy;
}

export async function uploadLocalFile(
  client: Client,
  input: UploadLocalFileInput,
): Promise<FsEntry> {
  const localPath = resolve(input.localPath);
  let sourceStat: Stats;
  try {
    sourceStat = await stat(localPath);
  } catch (err) {
    throw new UsageError(`local file is not readable: ${localPath} (${String(err)})`);
  }
  if (!sourceStat.isFile()) throw new UsageError(`local path is not a regular file: ${localPath}`);
  const source = Readable.toWeb(createReadStream(localPath)) as ReadableStream<Uint8Array>;
  const result = await client.fsWrite({
    path: input.path,
    mimeType: input.mimeType ?? inferMimeType(localPath),
    source,
    collision: input.collision ?? 'error',
  });
  return result.entry;
}

export interface DownloadLocalFileInput {
  path: string;
  localPath: string;
  overwrite?: boolean;
}

export async function downloadLocalFile(
  client: Client,
  input: DownloadLocalFileInput,
): Promise<{ localPath: string; size: number }> {
  const localPath = resolve(input.localPath);
  await mkdir(dirname(localPath), { recursive: true });
  const temporary = resolve(
    dirname(localPath),
    `.${basename(localPath)}.csuite-download-${process.pid}-${randomUUID()}`,
  );
  try {
    const source = await client.fsReadStream(input.path);
    await pipeline(
      Readable.fromWeb(source as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(temporary, { flags: 'wx' }),
    );
    if (input.overwrite) {
      await rename(temporary, localPath);
    } else {
      await link(temporary, localPath);
      await unlink(temporary);
    }
    return { localPath, size: (await stat(localPath)).size };
  } catch (err) {
    await unlink(temporary).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UsageError(`local destination exists (pass overwrite=true): ${localPath}`);
    }
    throw err;
  }
}

export interface FsCommandInput {
  subcommand: string | undefined;
  positionals: string[];
  mimeType?: string;
  collision?: string;
  overwrite?: boolean;
}

export async function runFsCommand(
  input: FsCommandInput,
  client: Client,
  log: (line: string) => void,
): Promise<void> {
  if (input.subcommand === 'put') {
    const [localPath, path, ...extra] = input.positionals;
    if (!localPath || !path || extra.length > 0) {
      throw new UsageError('fs put: expected <local-path> <csuite-path>');
    }
    const collision = input.collision ?? 'error';
    if (collision !== 'error' && collision !== 'suffix' && collision !== 'overwrite') {
      throw new UsageError(`fs put: invalid --collide '${collision}'`);
    }
    const entry = await uploadLocalFile(client, {
      localPath,
      path,
      mimeType: input.mimeType,
      collision,
    });
    log(JSON.stringify(entry));
    return;
  }
  if (input.subcommand === 'get') {
    const [path, localPath, ...extra] = input.positionals;
    if (!path || !localPath || extra.length > 0) {
      throw new UsageError('fs get: expected <csuite-path> <local-path>');
    }
    const result = await downloadLocalFile(client, { path, localPath, overwrite: input.overwrite });
    log(`downloaded ${path} -> ${result.localPath}: size=${result.size}`);
    return;
  }
  throw new UsageError('fs: expected put|get');
}
