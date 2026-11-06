import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { BulkDomainError } from './bulk.domain-error.js';
import {
  BULK_MAX_FILE_BYTES,
  BULK_MAX_ROWS,
  BULK_MAX_XLSX_EXPANDED_BYTES,
  BULK_TEMPLATE_HEADERS,
  createBulkTemplateCsv,
  createBulkTemplateXlsx,
  parseBulkTemplate,
} from './bulk-template-v2.js';
import { createValidBulkXlsx } from '../../test/support/bulk-template-fixtures.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function compressedZipEntry(name: string, content: Buffer): Buffer {
  const entryName = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(content);
  const checksum = crc32(content);
  const local = Buffer.alloc(30 + entryName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(entryName.length, 26);
  entryName.copy(local, 30);
  const directory = Buffer.alloc(46 + entryName.length);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x0800, 8);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(checksum, 16);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(content.length, 24);
  directory.writeUInt16LE(entryName.length, 28);
  directory.writeUInt32LE(local.length + compressed.length, 42);
  entryName.copy(directory, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, directory, end]);
}

function csvRow(overrides: Record<number, string> = {}): Buffer {
  const values = [
    'ALTA',
    '',
    '',
    'SKU-BASE',
    '',
    'Producto',
    'Descripción',
    'cat-1',
    'marca-1',
    'tipo-1',
    'false',
    '10.50',
    '[]',
    '',
    'https://example.com/img.jpg',
    '0',
  ];
  for (const [index, value] of Object.entries(overrides))
    values[Number(index)] = value;
  return Buffer.from(
    `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
    'utf8',
  );
}

describe('Bulk template v2 parser', () => {
  it('parses valid CSV rows into normalized Catalog and workflow inputs', () => {
    const result = parseBulkTemplate(csvRow(), 'CSV');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.product).toMatchObject({
      nombre: 'Producto',
      precioBaseInicial: 10.5,
      tieneVariantes: false,
    });
    expect(result.rows[0]?.variant).toBeNull();
    expect(result.rows[0]?.rowOperationId).toBe(result.rows[0]?.rowId);
    expect(parseBulkTemplate(csvRow(), 'CSV').rows[0]?.rowId).toBe(
      result.rows[0]?.rowId,
    );
  });

  it('accepts variant SKU on ACTUALIZACION only as a lookup key, without placing it in the mutation DTO', () => {
    const values = [
      'ACTUALIZACION',
      '11111111-1111-4111-8111-111111111111',
      '0',
      'BASE',
      'VAR-LOOKUP',
      'Producto',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'true',
      '',
      '[]',
      '{"identificadores":[],"no_identificadores":[]}',
      '',
      '0',
    ];
    values[2] = '{"producto":0,"variante":0}';
    const parsed = parseBulkTemplate(
      Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
      ),
      'CSV',
    );
    expect(parsed.rows[0]?.skuVariant).toBe('VAR-LOOKUP');
    expect(parsed.rows[0]?.variantId).toBeNull();
    expect(parsed.rows[0]?.variant).not.toHaveProperty('sku');
  });

  it('rejects positive stock on ACTUALIZACION before creating domain effects', () => {
    const values = [
      'ACTUALIZACION',
      '11111111-1111-4111-8111-111111111111',
      '{"producto":0,"variante":null}',
      'BASE',
      '',
      'Producto',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'false',
      '',
      '[]',
      '',
      '',
      '2',
    ];
    const csv = Buffer.from(
      `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
      'utf8',
    );

    expect(() => parseBulkTemplate(csv, 'CSV')).toThrow(
      'stock_inicial positivo no se admite en ACTUALIZACION.',
    );
  });

  it('rejects invalid headers, content and unsupported versions without returning partial rows', () => {
    const invalidHeader = csvRow()
      .toString('utf8')
      .replace('operacion,', 'operation,');
    expect(() => parseBulkTemplate(Buffer.from(invalidHeader), 'CSV')).toThrow(
      BulkDomainError,
    );
    expect(() => parseBulkTemplate(csvRow({ 10: 'TRUE' }), 'CSV')).toThrow(
      BulkDomainError,
    );
    expect(() => parseBulkTemplate(Buffer.from(''), 'CSV')).toThrow(
      BulkDomainError,
    );
    const first = [
      'ALTA',
      '',
      '',
      'DUP-SKU',
      '',
      'Producto',
      'Descripción',
      'cat-1',
      'marca-1',
      'tipo-1',
      'false',
      '10',
      '[]',
      '',
      '',
      '0',
    ];
    const second = [...first];
    second[5] = 'Otro';
    expect(() =>
      parseBulkTemplate(
        Buffer.from(
          `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${first.join(',')}\r\n${second.join(',')}\r\n`,
        ),
        'CSV',
      ),
    ).toThrow(/SKU vendible duplicado/);
  });

  it('accepts 5,000 CSV data rows and rejects the next row', () => {
    const row = (index: number) =>
      [
        'ALTA',
        '',
        '',
        `SKU-LIMIT-${index}`,
        '',
        'Producto',
        'Descripción',
        'cat-1',
        'marca-1',
        'tipo-1',
        'false',
        '10.50',
        '[]',
        '',
        '',
        '0',
      ].join(',');
    const csv = (count: number) =>
      Buffer.from(
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${Array.from(
          { length: count },
          (_, index) => row(index),
        ).join('\r\n')}\r\n`,
        'utf8',
      );

    expect(parseBulkTemplate(csv(BULK_MAX_ROWS), 'CSV').rows).toHaveLength(
      BULK_MAX_ROWS,
    );
    expect(() => parseBulkTemplate(csv(BULK_MAX_ROWS + 1), 'CSV')).toThrow(
      /5 000|5,000|5000|límite/i,
    );
  });

  it('rejects XLSX content expanded beyond 50 MiB before inflation', () => {
    const bytes = compressedZipEntry(
      'xl/worksheets/sheet1.xml',
      Buffer.alloc(BULK_MAX_XLSX_EXPANDED_BYTES + 1, 0x41),
    );
    expect(bytes.length).toBeLessThan(BULK_MAX_FILE_BYTES);
    expect(() => parseBulkTemplate(bytes, 'XLSX')).toThrow(
      /50 MiB descomprimidos/i,
    );
  }, 15_000);

  it('serves an XLSX OOXML template with exactly the contractual headers', () => {
    const bytes = createBulkTemplateXlsx();
    expect(bytes.subarray(0, 2).toString('hex')).toBe('504b');
    expect(() => parseBulkTemplate(bytes, 'XLSX')).toThrow(/al menos una fila/);
    expect(createBulkTemplateCsv().toString('utf8')).toBe(
      `${BULK_TEMPLATE_HEADERS.join(',')}\r\n`,
    );
  });

  it('parses valid XLSX rows into normalized Catalog and workflow inputs', () => {
    const result = parseBulkTemplate(createValidBulkXlsx(), 'XLSX');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.product).toMatchObject({
      nombre: 'Producto',
      precioBaseInicial: 15.25,
    });
    expect(result.rows[0]?.skuBase).toBe('SKU-XLSX');
  });
});
