import { describe, expect, it } from 'vitest';
import { BulkDomainError } from './bulk.domain-error.js';
import { BULK_TEMPLATE_HEADERS, createBulkTemplateCsv, createBulkTemplateXlsx, parseBulkTemplate } from './bulk-template-v2.js';

function csvRow(overrides: Record<number, string> = {}): Buffer {
  const values = ['ALTA', '', '', 'SKU-BASE', '', 'Producto', 'Descripción', 'cat-1', 'marca-1', 'tipo-1', 'false', '10.50', '[]', '', 'https://example.com/img.jpg', '0'];
  for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
  return Buffer.from(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n${values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`, 'utf8');
}

describe('Bulk template v2 parser', () => {
  it('parses valid CSV rows into normalized Catalog and workflow inputs', () => {
    const result = parseBulkTemplate(csvRow(), 'CSV');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.product).toMatchObject({ nombre: 'Producto', precioBaseInicial: 10.5, tieneVariantes: false });
    expect(result.rows[0]?.variant).toBeNull();
    expect(result.rows[0]?.rowOperationId).toBe(result.rows[0]?.rowId);
    expect(parseBulkTemplate(csvRow(), 'CSV').rows[0]?.rowId).toBe(result.rows[0]?.rowId);
  });

  it('rejects invalid headers, content and unsupported versions without returning partial rows', () => {
    const invalidHeader = csvRow().toString('utf8').replace('operacion,', 'operation,');
    expect(() => parseBulkTemplate(Buffer.from(invalidHeader), 'CSV')).toThrow(BulkDomainError);
    expect(() => parseBulkTemplate(csvRow({ 10: 'TRUE' }), 'CSV')).toThrow(BulkDomainError);
    expect(() => parseBulkTemplate(Buffer.from(''), 'CSV')).toThrow(BulkDomainError);
    const first = ['ALTA', '', '', 'DUP-SKU', '', 'Producto', 'Descripción', 'cat-1', 'marca-1', 'tipo-1', 'false', '10', '[]', '', '', '0'];
    const second = [...first]; second[5] = 'Otro';
    expect(() => parseBulkTemplate(Buffer.from(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n${first.join(',')}\r\n${second.join(',')}\r\n`), 'CSV')).toThrow(/SKU vendible duplicado/);
  });

  it('serves an XLSX OOXML template with exactly the contractual headers', () => {
    const bytes = createBulkTemplateXlsx();
    expect(bytes.subarray(0, 2).toString('hex')).toBe('504b');
    expect(() => parseBulkTemplate(bytes, 'XLSX')).toThrow(/al menos una fila/);
    expect(createBulkTemplateCsv().toString('utf8')).toBe(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n`);
  });
});
