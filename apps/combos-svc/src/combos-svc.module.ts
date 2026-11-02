import { Module } from '@nestjs/common';
import { CombosSvcController } from './combos-svc.controller.js';
import { CombosSvcService } from './combos-svc.service.js';
import { CombosDatabase } from './persistence/combos.database.js';
import { CombosRepository } from './persistence/combos.repository.js';

@Module({
  imports: [],
  controllers: [CombosSvcController],
  providers: [CombosSvcService, CombosDatabase, CombosRepository],
})
export class CombosSvcModule {}
