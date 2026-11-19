import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';
import { verifyBulkBearer } from '../auth/bulk-user-bearer.guard.js';
import { BulkPersistenceRepository } from '../persistence/bulk.repository.js';
import { BulkProblemFilter } from './bulk-problem.filter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('api/v1/interno/carga-masiva/contenidos')
@UseFilters(BulkProblemFilter)
export class BulkCatalogContentController {
  constructor(private readonly repository: BulkPersistenceRepository) {}

  @Get(':contentId')
  @Header('Cache-Control', 'no-store')
  async obtenerContenidoCargaMasivaInternoH5(
    @Param('contentId') contentId: string,
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization?: string,
  ) {
    if (
      process.env.BULK_CATALOG_CONTENT_ENABLED !== 'true' ||
      process.env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED'
    )
      throw new NotFoundException('ARCHIVO_NO_ENCONTRADO');
    const claims = await verifyBulkBearer(authorization, 'G7_AUTHENTICATED');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const scopes =
      typeof claims.scope === 'string'
        ? claims.scope.split(/\s+/)
        : claims.scope;
    if (
      claims.tipo !== 'servicio' ||
      claims.sub !== 'catalog-svc' ||
      (claims.client_id !== undefined && claims.client_id !== claims.sub) ||
      !audience.every((value) => typeof value === 'string') ||
      !audience.includes('api-productos') ||
      !Array.isArray(scopes) ||
      !scopes.every((value) => typeof value === 'string') ||
      !scopes.includes('carga-masiva:contenidos:leer')
    )
      throw new ForbiddenException('SCOPE_INSUFICIENTE');
    if (!UUID.test(contentId)) throw new BadRequestException('VALIDACION');

    const content = await this.repository
      .findCatalogContent(contentId)
      .catch(() => {
        throw new ServiceUnavailableException('SERVICIO_NO_DISPONIBLE');
      });
    if (!content) throw new NotFoundException('ARCHIVO_NO_ENCONTRADO');
    response.setHeader('X-Content-SHA256', content.sha256);
    return new StreamableFile(content.bytes, {
      type: 'application/json',
      length: content.bytes.length,
    });
  }
}
