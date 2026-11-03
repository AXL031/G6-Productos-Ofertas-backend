import { validarLogo } from './brand-logo.js';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('validación contractual de logo', () => {
  it.each([
    [
      'image/png',
      readFileSync(resolve('apps/taxonomy-svc/test/fixtures/logo.png')),
    ],
    [
      'image/jpeg',
      readFileSync(resolve('apps/taxonomy-svc/test/fixtures/logo.jpg')),
    ],
    [
      'image/webp',
      readFileSync(resolve('apps/taxonomy-svc/test/fixtures/logo.webp')),
    ],
  ])('acepta firma y MIME %s', (mimetype, buffer) => {
    expect(validarLogo({ buffer, mimetype })).toEqual({
      bytes: buffer,
      mime: mimetype,
    });
    expect(() =>
      validarLogo({ buffer: buffer.subarray(0, buffer.length - 1), mimetype }),
    ).toThrow(ProblemDetailsException);
  });
  it('rechaza ausencia y contenido que no corresponde al MIME', () => {
    expect(() => validarLogo(undefined)).toThrow(ProblemDetailsException);
    expect(() =>
      validarLogo({ buffer: Buffer.from('fake'), mimetype: 'image/png' }),
    ).toThrow(ProblemDetailsException);
    try {
      validarLogo({ buffer: Buffer.from('fake'), mimetype: 'image/png' });
    } catch (error) {
      expect((error as ProblemDetailsException).problem.code).toBe(
        'LOGO_INVALIDO',
      );
    }
  });
  it('rechaza PNG con datos alterados aun cuando conserve la cabecera', () => {
    const png = readFileSync(
      resolve('apps/taxonomy-svc/test/fixtures/logo.png'),
    );
    const corrupto = Buffer.from(png);
    corrupto[corrupto.length - 6] = (corrupto[corrupto.length - 6] ?? 0) ^ 1;
    expect(() =>
      validarLogo({ buffer: corrupto, mimetype: 'image/png' }),
    ).toThrow(ProblemDetailsException);
  });
  it('rechaza archivos de más de 5 MiB con código 413 contractual', () => {
    try {
      validarLogo({
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
        mimetype: 'image/png',
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProblemDetailsException).problem).toMatchObject({
        status: 413,
        code: 'LOGO_EXCEDE_LIMITE',
      });
    }
  });
});
