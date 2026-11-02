import { describe, expect, it } from 'vitest';
import { BulkDomainError } from './bulk.domain-error.js';
import {
  BULK_TEMPLATE_HEADERS,
  createBulkTemplateCsv,
  createBulkTemplateXlsx,
  parseBulkTemplate,
} from './bulk-template-v2.js';

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

function validXlsxRow(): Buffer {
  const values = [
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
  ];
  const data = [
    'ALTA',
    '',
    '',
    'SKU-XLSX',
    '',
    'Producto',
    'Descripción',
    'cat-1',
    'marca-1',
    'tipo-1',
    'false',
    '15.25',
    '[]',
    '',
    '',
    '0',
  ];
  const cell = (value: string, index: number, row: number) => {
    let n = index + 1;
    let col = '';
    while (n) {
      n--;
      col = String.fromCharCode(65 + (n % 26)) + col;
      n = Math.floor(n / 26);
    }
    return `<c r="${col}${row}" t="inlineStr"><is><t>${value}</t></is></c>`;
  };
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries = [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${values.map((value, i) => cell(value, i, 1)).join('')}</row><row r="2">${data.map((value, i) => cell(value, i, 2)).join('')}</row></sheetData></worksheet>`,
    ],
  ].map(([name, xml]) => ({
    name: Buffer.from(name!),
    bytes: Buffer.from(xml!),
  }));
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const sum = crc32(entry.bytes);
    const head = Buffer.alloc(30 + entry.name.length);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(entry.bytes.length, 18);
    head.writeUInt32LE(entry.bytes.length, 22);
    head.writeUInt16LE(entry.name.length, 26);
    entry.name.copy(head, 30);
    local.push(head, entry.bytes);
    const dir = Buffer.alloc(46 + entry.name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(entry.bytes.length, 20);
    dir.writeUInt32LE(entry.bytes.length, 24);
    dir.writeUInt16LE(entry.name.length, 28);
    dir.writeUInt32LE(offset, 42);
    entry.name.copy(dir, 46);
    central.push(dir);
    offset += head.length + entry.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
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

  it('serves an XLSX OOXML template with exactly the contractual headers', () => {
    const bytes = createBulkTemplateXlsx();
    expect(bytes.subarray(0, 2).toString('hex')).toBe('504b');
    expect(() => parseBulkTemplate(bytes, 'XLSX')).toThrow(/al menos una fila/);
    expect(createBulkTemplateCsv().toString('utf8')).toBe(
      `${BULK_TEMPLATE_HEADERS.join(',')}\r\n`,
    );
  });

  it('parses valid XLSX rows into normalized Catalog and workflow inputs', () => {
    const result = parseBulkTemplate(validXlsxRow(), 'XLSX');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.product).toMatchObject({
      nombre: 'Producto',
      precioBaseInicial: 15.25,
    });
    expect(result.rows[0]?.skuBase).toBe('SKU-XLSX');
  });
});
