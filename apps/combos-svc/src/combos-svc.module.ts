import { Module } from '@nestjs/common';
import { CombosSvcController } from './combos-svc.controller.js';
import { CombosSvcService } from './combos-svc.service.js';
import { CombosDatabase } from './persistence/combos.database.js';
import { CombosRepository } from './persistence/combos.repository.js';
import { CombosEventConsumer } from './messaging/combos-event-consumer.js';

@Module({
  imports: [],
  controllers: [CombosSvcController],
  providers: [
    CombosSvcService,
    CombosDatabase,
    CombosRepository,
    CombosEventConsumer,
  ],
})
export class CombosSvcModule {}
