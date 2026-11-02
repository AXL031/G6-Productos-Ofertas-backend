import { randomUUID } from 'node:crypto';
import { BulkExportService } from './bulk-export.service.js';

describe('BulkExportService (isolated)', () => {
  it('persists valid admission and closes missing-source jobs without output', async () => {
    const job = {
      exportId: randomUUID(),
      status: 'QUEUED',
      format: 'CSV',
      outputFileId: null,
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
      completedAt: null,
    };
    const repository = {
      createExportJob: vi.fn(
        async (input: { exportId: string; format: string }) => ({
          ...job,
          exportId: input.exportId,
          format: input.format,
        }),
      ),
      transitionExportJob: vi
        .fn()
        .mockResolvedValueOnce({ ...job, status: 'PROCESSING' })
        .mockResolvedValueOnce({ ...job, status: 'FAILED_GENERAL' }),
      listQueuedExportJobs: vi.fn().mockResolvedValue([]),
    };
    const service = new BulkExportService(repository as never);
    const accepted = await service.create('CSV');
    expect(repository.createExportJob).toHaveBeenCalledWith({
      exportId: accepted.export_id,
      format: 'CSV',
    });
    expect(accepted).toMatchObject({
      status: 'QUEUED',
      formato: 'CSV',
      download_url: null,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(repository.transitionExportJob.mock.calls).toEqual([
      [accepted.export_id, ['QUEUED'], 'PROCESSING'],
      [accepted.export_id, ['PROCESSING'], 'FAILED_GENERAL'],
    ]);
  });

  it('rejects unsupported formats before persistence', async () => {
    const repository = { createExportJob: vi.fn() };
    const service = new BulkExportService(repository as never);
    await expect(service.create('PDF' as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(repository.createExportJob).not.toHaveBeenCalled();
  });
});
