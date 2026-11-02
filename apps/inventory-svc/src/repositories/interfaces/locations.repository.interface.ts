import { IDatabaseClient } from '../../database/database.interface.js';

export interface LocationEntity {
  id: string;
  code: string;
  name: string;
  type: string;
  external_ref?: string | null;
  active: boolean;
}

export interface ILocationsRepository {
  findActive(client?: IDatabaseClient): Promise<LocationEntity[]>;
}
