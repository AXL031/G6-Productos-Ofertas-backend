import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CatalogTokenVerifier } from './catalog-auth.js';
import { BarcodeRepository } from './barcode.repository.js';

export type BarcodeCommand =
  | { operation: 'register'; sku: string; codigo_barras: string }
  | { operation: 'list'; sku: string }
  | { operation: 'retire'; codigo_barras: string };
export function barcodeText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw new BadRequestException();
}

@Injectable()
export class BarcodeService {
  constructor(
    private readonly repository: BarcodeRepository,
    private readonly verifier: CatalogTokenVerifier,
  ) {}

  async resolve(code: string) {
    let sku: string | null;
    try {
      sku = await this.repository.resolve(code);
    } catch {
      throw new ServiceUnavailableException();
    }
    if (sku === null)
      throw new HttpException({ code: 'CODIGO_BARRAS_NO_ENCONTRADO' }, 404);
    return { sku };
  }

  async administer(command: BarcodeCommand, authorization: string) {
    const token = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!token) throw new ForbiddenException();
    const actor = await this.verifier.verify(token[1]);
    if (actor.kind !== 'user' || !actor.roles.includes('GESTOR_COMERCIAL'))
      throw new ForbiddenException();
    if (command.operation === 'register') {
      barcodeText(command.codigo_barras);
      barcodeText(command.sku);
      return this.repository.register(
        command.codigo_barras,
        command.sku,
        actor.subject,
      );
    }
    if (command.operation === 'retire') {
      barcodeText(command.codigo_barras);
      return this.repository.retire(command.codigo_barras, actor.subject);
    }
    if (command.operation !== 'list') throw new BadRequestException();
    barcodeText(command.sku);
    return this.repository.list(command.sku);
  }
}
