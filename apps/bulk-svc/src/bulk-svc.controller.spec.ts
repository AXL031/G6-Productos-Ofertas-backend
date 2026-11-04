import { Test, TestingModule } from '@nestjs/testing';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkReadinessService } from './health/bulk-readiness.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkExportService } from './bulk-export.service.js';

describe('BulkSvcController', () => {
  let controller: BulkSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [BulkSvcController],
      providers: [
        BulkSvcService,
        { provide: BulkImportService, useValue: {} },
        { provide: BulkStorageService, useValue: {} },
        { provide: BulkExportService, useValue: {} },
        {
          provide: BulkReadinessService,
          useValue: { check: vi.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    controller = app.get<BulkSvcController>(BulkSvcController);
  });

  describe('health', () => {
    it('should return health status for bulk-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'bulk-svc',
      });
    });
  });

  it('reports readiness without exposing database details', async () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnValue(undefined),
    };
    await controller.getReadiness(response as never);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      status: 'not_ready',
      service: 'bulk-svc',
    });
  });
});
