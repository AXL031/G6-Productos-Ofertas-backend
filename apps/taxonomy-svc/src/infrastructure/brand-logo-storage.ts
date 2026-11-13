import { createHash, randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LogoValidado } from '../domain/brand-logo.js';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';

export async function persistirLogo(logo: LogoValidado): Promise<string> {
  const directory = process.env.TAXONOMY_LOGO_DIRECTORY;
  const rawBase = process.env.TAXONOMY_LOGO_PUBLIC_BASE_URL;
  const base = rawBase && URL.parse(rawBase);
  if (
    !directory ||
    !isAbsolute(directory) ||
    !base ||
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith('/')
  )
    throw ProblemDetailsException.noDisponible();

  const extension = logo.mime === 'image/jpeg' ? 'jpg' : logo.mime.slice(6);
  const digest = createHash('sha256').update(logo.bytes).digest('hex');
  const name = digest + '.' + extension;
  const temporary = join(directory, '.logo-' + randomUUID());
  try {
    await writeFile(temporary, logo.bytes, { flag: 'wx', mode: 0o644 });
    await rename(temporary, join(directory, name));
    return new URL(name, base).href;
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw ProblemDetailsException.noDisponible();
  }
}
