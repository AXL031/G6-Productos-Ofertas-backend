import { ProblemDetailsException } from '../errors/taxonomy.errors.js';

export type LogoValidado = {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
};
const LIMITE = 5 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Valida tamaño, formato declarado y firma; no almacena ni genera URL. */
export function validarLogo(
  archivo: { buffer: Buffer; mimetype: string } | undefined,
): LogoValidado {
  if (!archivo || !Buffer.isBuffer(archivo.buffer))
    throw ProblemDetailsException.validacion('El logo es obligatorio.');
  if (archivo.buffer.length > LIMITE)
    throw new ProblemDetailsException({
      type: '/errores/logo-excede-limite',
      title: 'Logo excede límite',
      status: 413,
      code: 'LOGO_EXCEDE_LIMITE',
    });
  const data = archivo.buffer;
  const png =
    data.length >= 8 &&
    data.subarray(0, 8).equals(PNG) &&
    archivo.mimetype === 'image/png';
  const jpeg =
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff &&
    archivo.mimetype === 'image/jpeg';
  const webp =
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP' &&
    archivo.mimetype === 'image/webp';
  if (!png && !jpeg && !webp)
    throw new ProblemDetailsException({
      type: '/errores/logo-invalido',
      title: 'Logo inválido',
      status: 422,
      code: 'LOGO_INVALIDO',
    });
  return {
    bytes: data,
    mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp',
  };
}
