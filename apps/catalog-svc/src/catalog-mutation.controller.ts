import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CatalogAuthGuard, RequireCatalogIdentity } from './catalog-auth.js';
import { CatalogMutationService } from './catalog-mutation.service.js';
import { correlationId, isCorrelationId } from './correlation.js';

@Controller('api/v1/productos')
@UseGuards(CatalogAuthGuard)
@RequireCatalogIdentity({
  restrictedDemo: true,
  identity: 'user',
  roles: ['GESTOR_COMERCIAL'],
})
export class CatalogMutationController {
  constructor(private readonly service: CatalogMutationService) {}
  private actor(authorization?: string, id?: string) {
    if (id !== undefined && !isCorrelationId(id))
      throw new BadRequestException();
    return {
      authorization: authorization ?? '',
      correlationId: correlationId(id),
    };
  }
  @Post()
  createProduct(
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.createProduct(body, this.actor(auth, id));
  }
  @Patch(':productoId')
  updateProduct(
    @Param('productoId') p: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.update(p, undefined, body, this.actor(auth, id));
  }
  @Post(':productoId/activar')
  @HttpCode(200)
  activateProduct(
    @Param('productoId') p: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.state(
      p,
      undefined,
      'activate',
      body,
      this.actor(auth, id),
    );
  }
  @Post(':productoId/desactivar')
  @HttpCode(200)
  deactivateProduct(
    @Param('productoId') p: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.state(
      p,
      undefined,
      'deactivate',
      body,
      this.actor(auth, id),
    );
  }
  @Post(':productoId/reactivar')
  @HttpCode(200)
  reactivateProduct(
    @Param('productoId') p: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.state(
      p,
      undefined,
      'reactivate',
      body,
      this.actor(auth, id),
    );
  }
  @Post(':productoId/preparacion/reintentar')
  @HttpCode(202)
  retryProduct(
    @Param('productoId') p: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.retry(p, undefined, body, this.actor(auth, id));
  }
  @Post(':productoId/variantes')
  createVariant(
    @Param('productoId') p: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.createVariant(p, body, this.actor(auth, id));
  }
  @Patch(':productoId/variantes/:variantId')
  updateVariant(
    @Param('productoId') p: string,
    @Param('variantId') v: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.update(p, v, body, this.actor(auth, id));
  }
  @Post(':productoId/variantes/:variantId/activar')
  @HttpCode(200)
  activateVariant(
    @Param('productoId') p: string,
    @Param('variantId') v: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.state(
      p,
      v,
      'activate',
      undefined,
      this.actor(auth, id),
    );
  }
  @Post(':productoId/variantes/:variantId/desactivar')
  @HttpCode(200)
  deactivateVariant(
    @Param('productoId') p: string,
    @Param('variantId') v: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.state(
      p,
      v,
      'deactivate',
      undefined,
      this.actor(auth, id),
    );
  }
  @Post(':productoId/variantes/:variantId/reactivar')
  @HttpCode(200)
  reactivateVariant(
    @Param('productoId') p: string,
    @Param('variantId') v: string,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.state(
      p,
      v,
      'reactivate',
      undefined,
      this.actor(auth, id),
    );
  }
  @Post(':productoId/variantes/:variantId/preparacion/reintentar')
  @HttpCode(202)
  retryVariant(
    @Param('productoId') p: string,
    @Param('variantId') v: string,
    @Body() body: unknown,
    @Headers('authorization') auth?: string,
    @Headers('x-correlation-id') id?: string,
  ) {
    return this.service.retry(p, v, body, this.actor(auth, id));
  }
}
