import { Test, TestingModule } from '@nestjs/testing';
import { CombosSvcController } from './combos-svc.controller.js';
import { CombosSvcService } from './combos-svc.service.js';
import { CombosDatabase } from './persistence/combos.database.js';
import { CombosRepository } from './persistence/combos.repository.js';

describe('CombosSvcController', () => {
  let controller: CombosSvcController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [CombosSvcController],
      providers: [
        CombosSvcService,
        { provide: CombosDatabase, useValue: {} },
        { provide: CombosRepository, useValue: {} },
      ],
    }).compile();

    controller = app.get<CombosSvcController>(CombosSvcController);
  });

  describe('health', () => {
    it('should return health status for combos-svc', () => {
      expect(controller.getHealth()).toEqual({
        status: 'ok',
        service: 'combos-svc',
      });
    });
  });
});
