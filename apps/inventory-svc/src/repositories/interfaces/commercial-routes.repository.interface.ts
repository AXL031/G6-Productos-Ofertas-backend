import { IDatabaseClient } from '../../database/database.interface.js';

export interface CommercialRouteEntity {
  id: string;
  channel_id: string;
  mode: string;
  fulfillment_ref: string;
  location_id: string;
  active: boolean;
}

export interface ICommercialRoutesRepository {
  findActiveByChannelAndFulfillment(
    channelId: string,
    mode: string,
    fulfillmentRef: string | null,
    client?: IDatabaseClient,
  ): Promise<string | null>;

  findActiveByChannel(
    channelId: string,
    client?: IDatabaseClient,
  ): Promise<string | null>;
}
