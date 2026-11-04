import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  batchJobs,
  batchRows,
  exportJobs,
  fileManifests,
  inbox,
  outbox,
  rowDomainSteps,
} from './bulk.schema.js';

describe('bulk Drizzle schema', () => {
  it('maps exactly the seven official tables and their primary fields', () => {
    const tables = [
      fileManifests,
      batchJobs,
      batchRows,
      rowDomainSteps,
      exportJobs,
      outbox,
      inbox,
    ];
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      'file_manifests',
      'batch_jobs',
      'batch_rows',
      'row_domain_steps',
      'export_jobs',
      'outbox',
      'inbox',
    ]);
    expect(
      tables.every((table) => getTableConfig(table).schema === 'bulk'),
    ).toBe(true);
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.primaryKeys).toHaveLength(1);
      expect(
        config.primaryKeys[0]?.columns.map((column) => column.name),
      ).toEqual(['id']);
      expect(config.primaryKeys[0]?.getName()).toBe(`pk_${config.name}`);
    }
    expect(
      getTableConfig(fileManifests).columns.map((column) => column.name),
    ).toEqual([
      'id',
      'role',
      'format',
      'content_ref',
      'created_at',
      'updated_at',
    ]);
    expect(
      getTableConfig(outbox)
        .columns.find((column) => column.name === 'message_id')
        ?.getSQLType(),
    ).toBe('text');
    expect(
      getTableConfig(outbox)
        .columns.find((column) => column.name === 'correlation_id')
        ?.getSQLType(),
    ).toBe('text');
    expect(
      getTableConfig(outbox)
        .columns.find((column) => column.name === 'operation_id')
        ?.getSQLType(),
    ).toBe('uuid');
    expect(
      getTableConfig(batchRows)
        .columns.find((column) => column.name === 'required_domains')
        ?.getSQLType(),
    ).toBe('text[]');
    expect(getTableConfig(inbox).uniqueConstraints[0]?.getName()).toBe(
      'uq_inbox_message_handler',
    );
    expect(
      getTableConfig(batchJobs).foreignKeys.map((foreignKey) => [
        foreignKey.getName(),
        foreignKey.onDelete,
      ]),
    ).toEqual([
      ['fk_batch_jobs_input_file_id', 'restrict'],
      ['fk_batch_jobs_report_file_id', 'restrict'],
    ]);
    expect(getTableConfig(batchRows).foreignKeys[0]?.getName()).toBe(
      'fk_batch_rows_batch_job_id',
    );
    expect(getTableConfig(batchRows).foreignKeys[0]?.onDelete).toBe('cascade');
    expect(getTableConfig(rowDomainSteps).foreignKeys[0]?.getName()).toBe(
      'fk_row_domain_steps_batch_row_id',
    );
    expect(getTableConfig(rowDomainSteps).foreignKeys[0]?.onDelete).toBe(
      'cascade',
    );
    expect(getTableConfig(exportJobs).foreignKeys[0]?.getName()).toBe(
      'fk_export_jobs_output_file_id',
    );
    expect(getTableConfig(exportJobs).foreignKeys[0]?.onDelete).toBe(
      'restrict',
    );
  });

  it('declares the native lifecycle enums and the official partial/composite indexes', () => {
    const jobs = getTableConfig(batchJobs);
    const rows = getTableConfig(batchRows);
    const steps = getTableConfig(rowDomainSteps);
    expect(
      jobs.columns.find((column) => column.name === 'status')?.getSQLType(),
    ).toBe('job_status');
    expect(
      rows.columns.find((column) => column.name === 'status')?.getSQLType(),
    ).toBe('row_status');
    expect(
      steps.columns.find((column) => column.name === 'status')?.getSQLType(),
    ).toBe('step_status');
    expect(jobs.indexes.map((index) => index.config.name)).toEqual([
      'ix_batch_jobs_input_file_id',
      'ix_batch_jobs_status_created_at',
      'ix_batch_jobs_reconciliation',
    ]);
    expect(rows.indexes.map((index) => index.config.name)).toEqual([
      'ix_batch_rows_batch_status',
      'ix_batch_rows_reconciliation',
      'ix_batch_rows_failed_domain',
    ]);
    expect(getTableConfig(exportJobs).foreignKeys).toHaveLength(1);
  });
});
