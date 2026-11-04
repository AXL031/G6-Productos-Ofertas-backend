import { inflateSync } from 'node:zlib';
import { ProblemDetailsException } from '../errors/taxonomy.errors.js';

export type LogoValidado = {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
};
const LIMITE = 5 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngCompleto(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG)) return false;
  let pos = 8,
    ihdr = false,
    end = false;
  const partes: Buffer[] = [];
  while (pos + 12 <= data.length) {
    const size = data.readUInt32BE(pos);
    if (size > data.length - pos - 12) return false;
    const type = data.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8,
      finish = start + size;
    if (crc32(data.subarray(pos + 4, finish)) !== data.readUInt32BE(finish))
      return false;
    if (!ihdr) {
      if (
        type !== 'IHDR' ||
        size !== 13 ||
        data.readUInt32BE(start) === 0 ||
        data.readUInt32BE(start + 4) === 0
      )
        return false;
      ihdr = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') partes.push(data.subarray(start, finish));
    pos = finish + 4;
    if (type === 'IEND') {
      if (size !== 0 || pos !== data.length) return false;
      end = true;
      break;
    }
  }
  if (!end || !partes.length) return false;
  try {
    return (
      inflateSync(Buffer.concat(partes), { maxOutputLength: 64 * 1024 * 1024 })
        .length > 0
    );
  } catch {
    return false;
  }
}
function jpegCompleto(data: Buffer): boolean {
  if (
    data.length < 12 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  )
    return false;
  let pos = 2,
    frame = false,
    scan = false;
  while (pos < data.length - 1) {
    if (data[pos++] !== 0xff) return false;
    while (data[pos] === 0xff) pos++;
    const marker = data[pos++];
    if (marker === undefined || marker === 0) return false;
    if (marker === 0xd9) return pos === data.length && frame && scan;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > data.length) return false;
    const length = data.readUInt16BE(pos);
    if (length < 2 || pos + length > data.length) return false;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (
        length < 8 ||
        data.readUInt16BE(pos + 3) === 0 ||
        data.readUInt16BE(pos + 5) === 0
      )
        return false;
      frame = true;
    }
    pos += length;
    if (marker === 0xda) {
      scan = true;
      while (pos < data.length - 1) {
        if (data[pos] !== 0xff) {
          pos++;
          continue;
        }
        const next = data[pos + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          pos += 2;
          continue;
        }
        break;
      }
    }
  }
  return false;
}
function webpCompleto(data: Buffer): boolean {
  if (
    data.length < 20 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WEBP' ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    return false;
  let pos = 12,
    frame = false;
  while (pos + 8 <= data.length) {
    const kind = data.toString('ascii', pos, pos + 4);
    const size = data.readUInt32LE(pos + 4);
    const start = pos + 8;
    const next = start + size + (size & 1);
    if (next > data.length) return false;
    if (
      kind === 'VP8 ' &&
      size >= 10 &&
      data
        .subarray(start + 3, start + 6)
        .equals(Buffer.from([0x9d, 0x01, 0x2a]))
    )
      frame = true;
    if (kind === 'VP8L' && size >= 5 && data[start] === 0x2f) frame = true;
    pos = next;
  }
  return pos === data.length && frame;
}
/** Comprueba estructura, integridad PNG y límites; no almacena ni genera URL. */
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
  const png = archivo.mimetype === 'image/png' && pngCompleto(data);
  const jpeg = archivo.mimetype === 'image/jpeg' && jpegCompleto(data);
  const webp = archivo.mimetype === 'image/webp' && webpCompleto(data);
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
