import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { BulkDomainError } from './bulk.errors.js';
import {
  validateBulkImport,
  type NormalizedBulkRow,
} from './bulk.validation.js';

export const BULK_MAX_FILE_BYTES = 10_485_760;
export const BULK_MAX_ROWS = 5_000;
export const BULK_MAX_XLSX_EXPANDED_BYTES = 50 * 1024 * 1024;
export const BULK_TEMPLATE_HEADERS = [
  'operacion',
  'producto_id',
  'catalog_version',
  'sku_base',
  'sku_variante',
  'nombre',
  'descripcion',
  'categoria_id',
  'marca_id',
  'tipo_producto_id',
  'tiene_variantes',
  'precio_regular',
  'atributos_producto',
  'atributos_variante',
  'imagen_url',
  'stock_inicial',
] as const;

export type BulkTemplateMode = 'ALTA' | 'ACTUALIZACION';
export type BulkAttribute = {
  caracteristica_id: string;
  nombre: string;
  valor_id: string | null;
  valor: unknown;
};

export interface BulkCatalogRow {
  rowId: string;
  rowOperationId: string;
  rowNumber: number;
  mode: BulkTemplateMode;
  productId: string | null;
  skuBase: string;
  skuVariant: string | null;
  product: Record<string, unknown>;
  variantId: string | null;
  variant: Record<string, unknown> | null;
  vendibleSkus: string[];
  requiredDomains: Array<'CATALOGO' | 'PRICING' | 'INVENTARIO'>;
  stockInicial: number;
  defaultLocationId: null;
}

export interface ParsedBulkTemplate {
  format: 'CSV' | 'XLSX';
  templateVersion: 2;
  mode: BulkTemplateMode;
  rows: BulkCatalogRow[];
}

const headers = BULK_TEMPLATE_HEADERS as readonly string[];
function fail(
  code:
    | 'ARCHIVO_INVALIDO'
    | 'ARCHIVO_EXCEDE_LIMITE'
    | 'PLANTILLA_INCOMPATIBLE'
    | 'CONTENIDO_ACTIVO_NO_PERMITIDO',
  detail: string,
): never {
  throw new BulkDomainError(code, detail);
}

function decodeCsv(bytes: Buffer): string[][] {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(
      'ARCHIVO_INVALIDO',
      'El archivo CSV debe estar codificado en UTF-8.',
    );
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (
        (character === '\r' && source[index + 1] !== '\n') ||
        (character === '\n' && source[index - 1] !== '\r')
      )
        return fail(
          'ARCHIVO_INVALIDO',
          'Los saltos de línea CSV deben usar CRLF según RFC 4180.',
        );
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length !== 0 || closedQuote)
        return fail(
          'ARCHIVO_INVALIDO',
          'El CSV contiene comillas RFC 4180 malformadas.',
        );
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character !== '\r' || source[index + 1] !== '\n')
        return fail(
          'ARCHIVO_INVALIDO',
          'Los saltos de línea CSV deben usar CRLF según RFC 4180.',
        );
      index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      closedQuote = false;
    } else {
      if (closedQuote)
        return fail(
          'ARCHIVO_INVALIDO',
          'Hay contenido después del cierre de una celda CSV.',
        );
      cell += character;
    }
  }
  if (quoted)
    return fail(
      'ARCHIVO_INVALIDO',
      'El CSV termina dentro de una celda entrecomillada.',
    );
  if (cell.length > 0 || row.length > 0 || closedQuote) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  expandedSize: number;
  crc: number;
  localOffset: number;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipEntries(bytes: Buffer): Map<string, Buffer> {
  const minSearch = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minSearch; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0)
    return fail(
      'ARCHIVO_INVALIDO',
      'El XLSX no contiene un directorio ZIP válido.',
    );
  const disk = bytes.readUInt16LE(eocd + 4);
  const directoryDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount > 2_000 ||
    directoryOffset + directorySize > eocd ||
    eocd + 22 + commentLength !== bytes.length
  )
    return fail(
      'ARCHIVO_INVALIDO',
      'El XLSX está incompleto, multiparticionado o excede su estructura permitida.',
    );

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  let totalExpanded = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50)
      return fail(
        'ARCHIVO_INVALIDO',
        'El directorio ZIP del XLSX está malformado.',
      );
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentSize;
    if (
      next > eocd ||
      (flags & 1) !== 0 ||
      (flags & 0x40) !== 0 ||
      startDisk !== 0
    )
      return fail(
        'ARCHIVO_INVALIDO',
        'El XLSX usa cifrado o una estructura ZIP no soportada.',
      );
    if (method !== 0 && method !== 8)
      return fail(
        'ARCHIVO_INVALIDO',
        'El XLSX usa un método de compresión no permitido.',
      );
    if (
      expandedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      return fail('ARCHIVO_INVALIDO', 'No se admite ZIP64 en archivos XLSX.');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    const unixMode = externalAttributes >>> 16;
    if (
      !name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..') ||
      (unixMode & 0xf000) === 0xa000
    )
      return fail(
        'ARCHIVO_INVALIDO',
        'El XLSX contiene una ruta ZIP inválida.',
      );
    totalExpanded += expandedSize;
    if (totalExpanded > BULK_MAX_XLSX_EXPANDED_BYTES)
      return fail(
        'ARCHIVO_EXCEDE_LIMITE',
        'El XLSX excede 50 MiB descomprimidos.',
      );
    entries.push({
      name,
      method,
      compressedSize,
      expandedSize,
      crc,
      localOffset,
    });
    cursor = next;
  }
  if (cursor !== directoryOffset + directorySize)
    return fail(
      'ARCHIVO_INVALIDO',
      'El directorio ZIP del XLSX tiene bytes sobrantes.',
    );

  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    if (result.has(entry.name))
      return fail(
        'ARCHIVO_INVALIDO',
        'El XLSX contiene entradas ZIP duplicadas.',
      );
    const offset = entry.localOffset;
    if (
      offset + 30 > directoryOffset ||
      bytes.readUInt32LE(offset) !== 0x04034b50
    )
      return fail(
        'ARCHIVO_INVALIDO',
        'Una entrada local ZIP del XLSX está malformada.',
      );
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const contentStart = offset + 30 + nameLength + extraLength;
    const contentEnd = contentStart + entry.compressedSize;
    if (contentEnd > directoryOffset)
      return fail(
        'ARCHIVO_INVALIDO',
        'Una entrada local ZIP excede el directorio del XLSX.',
      );
    const compressed = bytes.subarray(contentStart, contentEnd);
    let expanded: Buffer;
    try {
      expanded =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              maxOutputLength: BULK_MAX_XLSX_EXPANDED_BYTES,
            });
    } catch {
      return fail(
        'ARCHIVO_INVALIDO',
        'No se pudo descomprimir el XLSX dentro del límite permitido.',
      );
    }
    if (expanded.length !== entry.expandedSize || crc32(expanded) !== entry.crc)
      return fail(
        'ARCHIVO_INVALIDO',
        'El tamaño o CRC de una entrada XLSX no coincide.',
      );
    result.set(entry.name, expanded);
  }
  return result;
}

function assertSafeXml(xml: string, name: string): void {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))
    fail(
      'CONTENIDO_ACTIVO_NO_PERMITIDO',
      `${name} contiene una declaración XML activa.`,
    );
  if (/<!\[CDATA\[|<\s*script\b|<\s*oleObject\b|<\s*externalLink\b/i.test(xml))
    fail(
      'CONTENIDO_ACTIVO_NO_PERMITIDO',
      `${name} contiene contenido activo o vínculos externos.`,
    );
  const stack: string[] = [];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[^?]*\?>|<[^>]+>/g) ?? [];
  const stripped = xml.replace(/<!--[\s\S]*?-->|<\?[^?]*\?>|<[^>]+>/g, '');
  if (stripped.includes('<') || stripped.includes('>'))
    fail('ARCHIVO_INVALIDO', `${name} no es XML bien formado.`);
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    const close = token.match(/^<\/([A-Za-z_][\w:.-]*)\s*>$/);
    if (close) {
      if (stack.pop() !== close[1])
        fail('ARCHIVO_INVALIDO', `${name} no es XML bien formado.`);
      continue;
    }
    const open = token.match(/^<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?\s*\/?>$/);
    if (!open) fail('ARCHIVO_INVALIDO', `${name} no es XML bien formado.`);
    if (!/\/\s*>$/.test(token)) stack.push(open[1]!);
  }
  if (stack.length > 0)
    fail('ARCHIVO_INVALIDO', `${name} contiene etiquetas XML sin cerrar.`);
}

function xmlAttribute(tag: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tag.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1] ?? null;
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, code: string) => {
      if (code === 'amp') return '&';
      if (code === 'lt') return '<';
      if (code === 'gt') return '>';
      if (code === 'quot') return '"';
      if (code === 'apos') return "'";
      const numeric =
        code[1]?.toLowerCase() === 'x'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      if (
        !Number.isInteger(numeric) ||
        numeric < 0 ||
        numeric > 0x10ffff ||
        (numeric >= 0xd800 && numeric <= 0xdfff)
      )
        fail('ARCHIVO_INVALIDO', 'El XLSX contiene una entidad XML inválida.');
      return String.fromCodePoint(numeric);
    },
  );
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  assertSafeXml(xml, 'xl/sharedStrings.xml');
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(
    ([, content]) =>
      [...(content ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map(([, text]) => decodeXmlText(text ?? ''))
        .join(''),
  );
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters)
    fail(
      'ARCHIVO_INVALIDO',
      'Una celda XLSX no contiene una referencia válida.',
    );
  let result = 0;
  for (const letter of letters)
    result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function parseXlsx(bytes: Buffer): string[][] {
  const files = readZipEntries(bytes);
  for (const name of files.keys()) {
    if (
      /(^|\/)(vbaProject\.bin|activeX|embeddings|externalLinks|queryTables|connections)(\/|\.|$)/i.test(
        name,
      ) ||
      /\.xlsm$/i.test(name)
    )
      fail(
        'CONTENIDO_ACTIVO_NO_PERMITIDO',
        'El XLSX contiene macros, vínculos u objetos activos.',
      );
  }
  const contentTypes = files.get('[Content_Types].xml');
  const workbookBytes = files.get('xl/workbook.xml');
  const relBytes = files.get('xl/_rels/workbook.xml.rels');
  if (!contentTypes || !workbookBytes || !relBytes)
    return fail(
      'ARCHIVO_INVALIDO',
      'Faltan partes OOXML requeridas para un XLSX.',
    );
  const contentXml = contentTypes.toString('utf8');
  const workbookXml = workbookBytes.toString('utf8');
  const relXml = relBytes.toString('utf8');
  assertSafeXml(contentXml, '[Content_Types].xml');
  assertSafeXml(workbookXml, 'xl/workbook.xml');
  assertSafeXml(relXml, 'xl/_rels/workbook.xml.rels');
  if (/macroEnabled|vbaProject/i.test(contentXml + workbookXml))
    fail(
      'CONTENIDO_ACTIVO_NO_PERMITIDO',
      'No se permiten libros XLSM ni proyectos VBA.',
    );
  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*>/g)];
  if (
    sheets.length !== 1 ||
    (xmlAttribute(sheets[0]![0], 'state') !== null &&
      xmlAttribute(sheets[0]![0], 'state') !== 'visible')
  )
    return fail(
      'PLANTILLA_INCOMPATIBLE',
      'El XLSX debe contener exactamente una hoja visible.',
    );
  const relationshipId = xmlAttribute(sheets[0]![0], 'r:id');
  if (!relationshipId)
    return fail(
      'ARCHIVO_INVALIDO',
      'La hoja XLSX no tiene una relación válida.',
    );
  const relationship = [...relXml.matchAll(/<Relationship\b[^>]*>/g)].find(
    ([tag]) => xmlAttribute(tag, 'Id') === relationshipId,
  )?.[0];
  if (!relationship || xmlAttribute(relationship, 'TargetMode') === 'External')
    fail(
      'CONTENIDO_ACTIVO_NO_PERMITIDO',
      'El XLSX referencia una hoja externa o no permitida.',
    );
  if (xmlAttribute(relationship, 'Type')?.endsWith('/worksheet') !== true)
    return fail(
      'PLANTILLA_INCOMPATIBLE',
      'La hoja declarada no es una hoja de cálculo.',
    );
  const target = xmlAttribute(relationship, 'Target');
  if (!target)
    return fail(
      'ARCHIVO_INVALIDO',
      'La relación de hoja XLSX no tiene destino.',
    );
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const normalizedPath = sheetPath
    .split('/')
    .reduce<string[]>((parts, part) => {
      if (part === '..') parts.pop();
      else if (part !== '.' && part !== '') parts.push(part);
      return parts;
    }, [])
    .join('/');
  if (!normalizedPath.startsWith('xl/worksheets/'))
    fail(
      'CONTENIDO_ACTIVO_NO_PERMITIDO',
      'La hoja XLSX apunta fuera del directorio de hojas.',
    );
  const sheetBytes = files.get(normalizedPath);
  if (!sheetBytes)
    return fail('ARCHIVO_INVALIDO', 'No existe la hoja declarada en el XLSX.');
  if (
    [...files.keys()].filter((name) =>
      /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(name),
    ).length !== 1
  )
    return fail(
      'PLANTILLA_INCOMPATIBLE',
      'El XLSX contiene hojas de cálculo adicionales.',
    );
  const sheetXml = sheetBytes.toString('utf8');
  assertSafeXml(sheetXml, normalizedPath);
  if (/<f(?:\s[^>]*)?>/i.test(sheetXml))
    fail('CONTENIDO_ACTIVO_NO_PERMITIDO', 'El XLSX contiene fórmulas.');
  const shared = parseSharedStrings(
    files.get('xl/sharedStrings.xml')?.toString('utf8'),
  );
  const rows: string[][] = [];
  for (const match of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (match[1] ?? '').matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g,
    )) {
      const attributes = cellMatch[1] ?? cellMatch[3] ?? '';
      const content = cellMatch[2] ?? '';
      const reference = xmlAttribute(`<c ${attributes}>`, 'r');
      if (!reference)
        fail('ARCHIVO_INVALIDO', 'Una celda XLSX no tiene referencia.');
      const index = columnIndex(reference);
      if (index >= headers.length)
        fail(
          'PLANTILLA_INCOMPATIBLE',
          'El XLSX contiene columnas adicionales.',
        );
      const type = xmlAttribute(`<c ${attributes}>`, 't');
      const valueTag = content.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
      const inline = content.match(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/)?.[1];
      let value = '';
      if (type === 's') {
        const sharedIndex = Number(valueTag);
        if (
          !Number.isInteger(sharedIndex) ||
          sharedIndex < 0 ||
          sharedIndex >= shared.length
        )
          fail(
            'ARCHIVO_INVALIDO',
            'Una celda XLSX referencia una cadena inexistente.',
          );
        value = shared[sharedIndex]!;
      } else if (type === 'inlineStr') {
        if (inline === undefined)
          fail('ARCHIVO_INVALIDO', 'Una celda inline XLSX está malformada.');
        value = [...inline.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
          .map(([, text]) => decodeXmlText(text ?? ''))
          .join('');
      } else if (type === undefined || type === 'n') {
        value = valueTag === undefined ? '' : decodeXmlText(valueTag);
      } else if (type === 'b') {
        value = valueTag === '1' ? 'true' : valueTag === '0' ? 'false' : '';
        if (value === '')
          fail(
            'ARCHIVO_INVALIDO',
            'Una celda booleana XLSX tiene un valor inválido.',
          );
      } else {
        fail(
          'PLANTILLA_INCOMPATIBLE',
          'El XLSX usa un tipo de celda no permitido.',
        );
      }
      cells[index] = value;
    }
    rows.push(
      Array.from({ length: headers.length }, (_, index) => cells[index] ?? ''),
    );
  }
  return rows;
}

function jsonCell<T>(value: string, column: string, fallback: T): T {
  if (value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fail(
      'PLANTILLA_INCOMPATIBLE',
      `${column} debe contener JSON válido.`,
    );
  }
}

function requireText(value: string, field: string): string {
  if (value.length === 0)
    fail('PLANTILLA_INCOMPATIBLE', `${field} es obligatorio.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deterministicUuid(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  const hex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}8${digest.slice(17, 20)}${digest.slice(20, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateAttributes(value: unknown, column: string): BulkAttribute[] {
  if (!Array.isArray(value))
    fail('PLANTILLA_INCOMPATIBLE', `${column} debe ser un array JSON.`);
  return value.map((attribute) => {
    if (!attribute || typeof attribute !== 'object' || Array.isArray(attribute))
      fail(
        'PLANTILLA_INCOMPATIBLE',
        `${column} contiene un atributo inválido.`,
      );
    const item = attribute as Record<string, unknown>;
    if (
      typeof item.caracteristica_id !== 'string' ||
      item.caracteristica_id.length === 0 ||
      typeof item.nombre !== 'string' ||
      item.nombre.length === 0 ||
      !Object.hasOwn(item, 'valor_id') ||
      (item.valor_id !== null && typeof item.valor_id !== 'string') ||
      !Object.hasOwn(item, 'valor')
    )
      fail(
        'PLANTILLA_INCOMPATIBLE',
        `${column} requiere caracteristica_id, nombre, valor_id y valor.`,
      );
    return item as BulkAttribute;
  });
}

function parseCatalogVersion(
  value: string,
  isVariant: boolean,
): { product: number; variant: number | null } | null {
  if (value === '') return null;
  const parsed = jsonCell<Record<string, unknown>>(
    value,
    'catalog_version',
    {},
  );
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some(
      (key) => key !== 'producto' && key !== 'variante',
    ) ||
    !Number.isSafeInteger(parsed.producto) ||
    Number(parsed.producto) < 0 ||
    !Object.hasOwn(parsed, 'variante') ||
    (parsed.variante !== null &&
      (!Number.isSafeInteger(parsed.variante) || Number(parsed.variante) < 0))
  )
    fail(
      'PLANTILLA_INCOMPATIBLE',
      'catalog_version debe contener producto y variante válidos.',
    );
  if (isVariant && parsed.variante === null)
    fail(
      'PLANTILLA_INCOMPATIBLE',
      'catalog_version.variante es obligatorio para una fila de variante.',
    );
  return {
    product: Number(parsed.producto),
    variant: parsed.variante as number | null,
  };
}

function parseDataRows(
  records: string[][],
  format: 'CSV' | 'XLSX',
): ParsedBulkTemplate {
  if (
    records.length === 0 ||
    canonicalJson(records[0]) !== canonicalJson(headers)
  )
    fail(
      'PLANTILLA_INCOMPATIBLE',
      'Las 16 cabeceras deben coincidir exactamente y conservar su orden.',
    );
  const data = records.slice(1);
  if (data.some((row) => row.every((value) => value === '')))
    fail('PLANTILLA_INCOMPATIBLE', 'No se permiten filas vacías intermedias.');
  if (data.length === 0)
    fail(
      'PLANTILLA_INCOMPATIBLE',
      'El archivo debe contener al menos una fila de datos.',
    );
  if (data.length > BULK_MAX_ROWS)
    throw new BulkDomainError(
      'ARCHIVO_EXCEDE_LIMITE',
      'El archivo supera 5 000 filas de datos.',
    );
  if (data.some((row) => row.length !== headers.length))
    fail(
      'PLANTILLA_INCOMPATIBLE',
      'Cada fila debe contener exactamente 16 celdas.',
    );

  const operation = data[0]![0];
  if (operation !== 'ALTA' && operation !== 'ACTUALIZACION')
    fail('PLANTILLA_INCOMPATIBLE', 'operacion debe ser ALTA o ACTUALIZACION.');
  if (data.some((row) => row[0] !== operation))
    fail(
      'PLANTILLA_INCOMPATIBLE',
      'Un archivo solo puede contener una operacion.',
    );
  const mode = operation as BulkTemplateMode;
  const parsedRows: BulkCatalogRow[] = [];
  const familySet = new Set<string>();
  let activeFamily: string | null = null;
  const familyFields = new Map<string, string>();
  const duplicateSku = new Set<string>();
  const duplicateVariantKeys = new Set<string>();
  const familyRows = new Map<string, number>();

  for (let index = 0; index < data.length; index += 1) {
    const values = data[index]!;
    const [
      ,
      rawProductId,
      rawVersion,
      rawSkuBase,
      rawVariantSku,
      rawName,
      rawDescription,
      rawCategory,
      rawBrand,
      rawProductType,
      rawHasVariants,
      rawPrice,
      rawProductAttributes,
      rawVariantAttributes,
      rawImage,
      rawStock,
    ] = values;
    const skuBase = requireText(rawSkuBase!, 'sku_base');
    if (activeFamily !== skuBase) {
      if (familySet.has(skuBase))
        fail(
          'PLANTILLA_INCOMPATIBLE',
          'Las filas de una familia sku_base deben ser contiguas.',
        );
      familySet.add(skuBase);
      activeFamily = skuBase;
    }
    familyRows.set(skuBase, (familyRows.get(skuBase) ?? 0) + 1);
    const hasVariants = rawHasVariants === 'true';
    if (rawHasVariants !== 'true' && rawHasVariants !== 'false')
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'tiene_variantes solo admite true o false en minúsculas.',
      );
    const productId = rawProductId === '' ? null : rawProductId!;
    if (mode === 'ALTA' && productId !== null)
      fail('PLANTILLA_INCOMPATIBLE', 'producto_id debe estar vacío en ALTA.');
    if (mode === 'ACTUALIZACION' && !productId)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'producto_id es obligatorio en ACTUALIZACION.',
      );
    const skuVariant = rawVariantSku === '' ? null : rawVariantSku!;
    if (hasVariants && !skuVariant)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'sku_variante es obligatorio para productos con variantes.',
      );
    if (!hasVariants && skuVariant)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'Un producto simple no admite sku_variante.',
      );
    const vendibleSku = skuVariant ?? skuBase;
    if (duplicateSku.has(vendibleSku))
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'El archivo contiene SKU vendible duplicado.',
      );
    duplicateSku.add(vendibleSku);

    const version = parseCatalogVersion(rawVersion!, hasVariants);
    if (mode === 'ALTA' && version !== null)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'catalog_version debe estar vacío en ALTA.',
      );
    if (mode === 'ACTUALIZACION' && version === null)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'catalog_version es obligatorio en ACTUALIZACION.',
      );
    const name = rawName!;
    const description = rawDescription!;
    const category = rawCategory!;
    const brand = rawBrand!;
    const productType = rawProductType!;
    if (mode === 'ALTA') {
      requireText(name, 'nombre');
      requireText(description, 'descripcion');
      requireText(category, 'categoria_id');
      requireText(brand, 'marca_id');
      requireText(productType, 'tipo_producto_id');
    }
    if (category === '' || brand === '' || productType === '')
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'categoria_id, marca_id y tipo_producto_id son obligatorios.',
      );
    if (rawPrice !== '' && mode === 'ACTUALIZACION')
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'precio_regular no se admite en ACTUALIZACION.',
      );
    let price: number | null = null;
    if (rawPrice !== '') {
      if (
        !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rawPrice!) ||
        Number(rawPrice) <= 0 ||
        !Number.isFinite(Number(rawPrice))
      )
        fail(
          'PLANTILLA_INCOMPATIBLE',
          'precio_regular debe ser un decimal positivo con punto.',
        );
      price = Number(rawPrice);
    }
    if (mode === 'ALTA' && price === null)
      fail('PLANTILLA_INCOMPATIBLE', 'precio_regular es obligatorio en ALTA.');
    const stock = rawStock === '' ? 0 : Number(rawStock);
    if (
      rawStock !== '' &&
      (!/^\d+$/.test(rawStock!) || !Number.isSafeInteger(stock))
    )
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'stock_inicial debe ser un entero no negativo.',
      );
    const productAttributes = validateAttributes(
      jsonCell<unknown>(rawProductAttributes!, 'atributos_producto', []),
      'atributos_producto',
    );
    const variantAttributes =
      rawVariantAttributes === ''
        ? null
        : jsonCell<Record<string, unknown>>(
            rawVariantAttributes!,
            'atributos_variante',
            {},
          );
    if (!hasVariants && variantAttributes !== null)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'atributos_variante debe estar vacío para un producto simple.',
      );
    if (
      hasVariants &&
      (!variantAttributes ||
        typeof variantAttributes !== 'object' ||
        Array.isArray(variantAttributes))
    )
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'atributos_variante debe contener identificadores y no_identificadores.',
      );
    let identifying: BulkAttribute[] = [];
    let nonIdentifying: BulkAttribute[] = [];
    if (variantAttributes) {
      if (
        Object.keys(variantAttributes).some(
          (key) => key !== 'identificadores' && key !== 'no_identificadores',
        )
      )
        fail(
          'PLANTILLA_INCOMPATIBLE',
          'atributos_variante contiene propiedades no permitidas.',
        );
      identifying = validateAttributes(
        variantAttributes.identificadores,
        'atributos_variante.identificadores',
      );
      nonIdentifying = validateAttributes(
        variantAttributes.no_identificadores,
        'atributos_variante.no_identificadores',
      );
    }
    if (hasVariants && mode === 'ALTA' && identifying.length === 0)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'Cada variante requiere al menos un atributo identificador.',
      );
    if (mode === 'ACTUALIZACION' && identifying.length > 0)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'ACTUALIZACION no permite cambiar atributos identificadores.',
      );
    const variantKey = `${skuBase}\u0000${canonicalJson(identifying)}`;
    if (hasVariants && mode === 'ALTA' && duplicateVariantKeys.has(variantKey))
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'La familia contiene combinaciones identificadoras duplicadas.',
      );
    if (hasVariants && mode === 'ALTA') duplicateVariantKeys.add(variantKey);
    const image = rawImage === '' ? null : rawImage!;
    if (image !== null) {
      let url: URL;
      try {
        url = new URL(image);
      } catch {
        return fail(
          'PLANTILLA_INCOMPATIBLE',
          'imagen_url debe ser una URI absoluta.',
        );
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        fail(
          'PLANTILLA_INCOMPATIBLE',
          'imagen_url debe ser una URI HTTP o HTTPS sin credenciales.',
        );
    }
    if (mode === 'ALTA' && hasVariants && image === null)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'imagen_url es obligatoria para variantes en ALTA.',
      );
    const product =
      mode === 'ALTA'
        ? {
            nombre: name,
            descripcion: description,
            categoriaId: category,
            tipoProductoId: productType,
            marcaId: brand,
            precioBaseInicial: price,
            skuBase,
            tieneVariantes: hasVariants,
            atributos: productAttributes,
            ...(!hasVariants && image
              ? { imagenes: [{ url: image, principal: true }] }
              : {}),
          }
        : {
            catalogVersion: version!.product,
            ...(name ? { nombre: name } : {}),
            ...(description ? { descripcion: description } : {}),
            ...(category ? { categoriaId: category } : {}),
            ...(brand ? { marcaId: brand } : {}),
            ...(rawProductAttributes !== ''
              ? { atributos: productAttributes }
              : {}),
            ...(!hasVariants && image
              ? { imagenes: [{ url: image, principal: true }] }
              : {}),
          };
    const variant = !hasVariants
      ? null
      : mode === 'ALTA'
        ? {
            sku: skuVariant,
            atributosIdentificadores: identifying,
            atributosNoIdentificadores: nonIdentifying,
            imagenUrl: image,
          }
        : {
            atributosNoIdentificadores: nonIdentifying,
            ...(image ? { imagenUrl: image } : {}),
            catalogVersion: version!.variant,
          };
    const familyValue = canonicalJson({
      productId,
      version: version?.product ?? null,
      name: mode === 'ALTA' || name ? name : null,
      description: mode === 'ALTA' || description ? description : null,
      category,
      brand,
      productType,
      hasVariants,
      price,
      productAttributes,
    });
    const previousFamily = familyFields.get(skuBase);
    if (previousFamily !== undefined && previousFamily !== familyValue)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'Las filas de la familia tienen datos de producto contradictorios.',
      );
    familyFields.set(skuBase, familyValue);
    const rowId = deterministicUuid(
      `${format}:${index + 2}:${canonicalJson(values)}`,
    );
    const normalizedForValidation: NormalizedBulkRow = {
      rowId,
      productId,
      skuBase,
      skuIdentityRequired: true,
      variantSkus: skuVariant ? [skuVariant] : [],
      precioRegular: price,
      stockInicial: stock,
      defaultLocationId: null,
      mode,
    };
    const validated = validateBulkImport({
      format,
      templateVersion: 2,
      rows: [normalizedForValidation],
    })[0]!;
    parsedRows.push({
      rowId,
      rowOperationId: rowId,
      rowNumber: index + 2,
      mode,
      productId,
      skuBase,
      skuVariant,
      product,
      variantId: null,
      variant,
      vendibleSkus: validated.vendibleSkus,
      requiredDomains: validated.requiredDomains,
      stockInicial: stock,
      defaultLocationId: null,
    });
  }

  for (const [skuBase, count] of familyRows) {
    const family = parsedRows.filter((row) => row.skuBase === skuBase);
    if (family[0]!.variant === null && count !== 1)
      fail(
        'PLANTILLA_INCOMPATIBLE',
        'Un producto simple debe ocupar una sola fila.',
      );
  }
  return { format, templateVersion: 2, mode, rows: parsedRows };
}

export function parseBulkTemplate(
  bytes: Buffer,
  format: 'CSV' | 'XLSX',
): ParsedBulkTemplate {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0)
    return fail('ARCHIVO_INVALIDO', 'El archivo de importación está vacío.');
  if (bytes.length > BULK_MAX_FILE_BYTES)
    throw new BulkDomainError(
      'ARCHIVO_EXCEDE_LIMITE',
      'El archivo supera 10 485 760 bytes.',
    );
  const records = format === 'CSV' ? decodeCsv(bytes) : parseXlsx(bytes);
  return parseDataRows(records, format);
}

export function createBulkTemplateCsv(): Buffer {
  return Buffer.from(`${headers.join(',')}\r\n`, 'utf8');
}

function zipStored(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.content);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.content.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export function createBulkTemplateXlsx(): Buffer {
  const cells = headers
    .map((header, index) => {
      let number = index + 1;
      let column = '';
      while (number > 0) {
        number -= 1;
        column = String.fromCharCode(65 + (number % 26)) + column;
        number = Math.floor(number / 26);
      }
      return `<c r="${column}1" t="inlineStr"><is><t>${header}</t></is></c>`;
    })
    .join('');
  const entries = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Plantilla v2" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
    ],
  ] as const;
  return zipStored(
    entries.map(([name, xml]) => ({ name, content: Buffer.from(xml, 'utf8') })),
  );
}
