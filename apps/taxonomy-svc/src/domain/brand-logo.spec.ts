import { validarLogo } from './brand-logo.js';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';

describe('validación contractual de logo', () => {
  it.each([
    ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['image/jpeg', Buffer.from('ffd8ff00', 'hex')],
    ['image/webp', Buffer.from('524946460400000057454250', 'hex')],
  ])('acepta firma y MIME %s', (mimetype, buffer) => {
    expect(validarLogo({ buffer, mimetype })).toEqual({
      bytes: buffer,
      mime: mimetype,
    });
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
