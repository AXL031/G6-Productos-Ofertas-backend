import { BULK_TEMPLATE_HEADERS } from '../../src/domain/bulk-template-v2.js';

export function createValidBulkCsv(sku = 'SKU-HTTP-CSV'): Buffer {
  const values = [
    'ALTA',
    '',
    '',
    sku,
    '',
    'Producto HTTP',
    'Descripción de prueba',
    'cat-1',
    'marca-1',
    'tipo-1',
    'false',
    '10.50',
    '[]',
    '',
    '',
    '0',
  ];
  return Buffer.from(
    `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
    'utf8',
  );
}

export function createValidBulkXlsx(sku = 'SKU-XLSX'): Buffer {
  const headers = [...BULK_TEMPLATE_HEADERS];
  const data = [
    'ALTA',
    '',
    '',
    sku,
    '',
    'Producto',
    'Descripción de prueba',
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
    let number = index + 1;
    let column = '';
    while (number) {
      number--;
      column = String.fromCharCode(65 + (number % 26)) + column;
      number = Math.floor(number / 26);
    }
    const escaped = value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<c r="${column}${row}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
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
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${headers.map((value, index) => cell(value, index, 1)).join('')}</row><row r="2">${data.map((value, index) => cell(value, index, 2)).join('')}</row></sheetData></worksheet>`,
    ],
  ].map(([name, xml]) => ({
    name: Buffer.from(name!),
    bytes: Buffer.from(xml!),
  }));
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30 + entry.name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(entry.name.length, 26);
    entry.name.copy(header, 30);
    local.push(header, entry.bytes);

    const directoryEntry = Buffer.alloc(46 + entry.name.length);
    directoryEntry.writeUInt32LE(0x02014b50, 0);
    directoryEntry.writeUInt16LE(20, 4);
    directoryEntry.writeUInt16LE(20, 6);
    directoryEntry.writeUInt16LE(0x0800, 8);
    directoryEntry.writeUInt32LE(checksum, 16);
    directoryEntry.writeUInt32LE(entry.bytes.length, 20);
    directoryEntry.writeUInt32LE(entry.bytes.length, 24);
    directoryEntry.writeUInt16LE(entry.name.length, 28);
    directoryEntry.writeUInt32LE(offset, 42);
    entry.name.copy(directoryEntry, 46);
    central.push(directoryEntry);
    offset += header.length + entry.bytes.length;
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
