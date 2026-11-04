export interface PromotionsClock {
  now(): Date;
}
export const PROMOTIONS_CLOCK = Symbol('PROMOTIONS_CLOCK');
