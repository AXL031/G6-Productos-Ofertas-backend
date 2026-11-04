import { SetMetadata } from '@nestjs/common';
import {
  REQUIRED_SCOPE_KEY,
  ALLOWED_CLIENTS_KEY,
  REQUIRED_CAPABILITY_KEY,
  ALLOW_USER_BEARER_KEY,
} from './auth.constants.js';

export const RequireScope = (scope: string) =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope);

export const AllowedClients = (clients: string[]) =>
  SetMetadata(ALLOWED_CLIENTS_KEY, clients);

export const RequireCapability = (capability: string) =>
  SetMetadata(REQUIRED_CAPABILITY_KEY, capability);

/** Habilita userBearer solo en las operaciones que lo declaran en OpenAPI. */
export const AllowUserBearer = () => SetMetadata(ALLOW_USER_BEARER_KEY, true);
