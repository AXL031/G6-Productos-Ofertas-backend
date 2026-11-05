export interface ISkuLifecycleRepository {
  findInactiveSkus(skus: string[]): Promise<Set<string>>;
}
