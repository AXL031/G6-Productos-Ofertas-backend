export type ProductStatus = 'BORRADOR' | 'ACTIVO' | 'INACTIVO';
export type VariantStatus = 'BORRADOR' | 'ACTIVA' | 'INACTIVA';
export type PreparationStatus = 'PENDING' | 'COMPLETED' | 'REJECTED';

export interface PhysicalProfile {
  pesoKg?: number | null;
  dimensionesCm?: {
    largo?: number | null;
    ancho?: number | null;
    alto?: number | null;
  } | null;
}

const physicalMeasurements = (profile: PhysicalProfile) => [
  profile.pesoKg,
  profile.dimensionesCm?.largo,
  profile.dimensionesCm?.ancho,
  profile.dimensionesCm?.alto,
];

export function isPhysicalProfileValid(profile: PhysicalProfile): boolean {
  return physicalMeasurements(profile).every(
    (value) => value == null || (Number.isFinite(value) && value > 0),
  );
}

export function isPhysicalProfileComplete(profile: PhysicalProfile): boolean {
  return (
    isPhysicalProfileValid(profile) &&
    physicalMeasurements(profile).every(
      (value) =>
        typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
  );
}

export interface VariantActivationFacts {
  status: VariantStatus;
  skuAndCombinationValid: boolean;
  attributesAndImageValid: boolean;
  physicalProfile: PhysicalProfile;
  inventoryStatus: PreparationStatus;
}

export interface ProductActivationFacts {
  minimumDataValid: boolean;
  mastersValid: boolean;
  requiredAttributesComplete: boolean;
  imageValid: boolean;
  pricingStatus: PreparationStatus;
  hasVariants: boolean;
  physicalProfile?: PhysicalProfile;
  inventoryStatus?: PreparationStatus;
  variants?: readonly VariantActivationFacts[];
}

export function canActivateVariant(
  parentHasVariants: boolean,
  variant: Omit<VariantActivationFacts, 'status'>,
): boolean {
  return (
    parentHasVariants &&
    variant.skuAndCombinationValid &&
    variant.attributesAndImageValid &&
    isPhysicalProfileComplete(variant.physicalProfile) &&
    variant.inventoryStatus === 'COMPLETED'
  );
}

export function canActivateProduct(facts: ProductActivationFacts): boolean {
  if (
    !facts.minimumDataValid ||
    !facts.mastersValid ||
    !facts.requiredAttributesComplete ||
    !facts.imageValid ||
    facts.pricingStatus !== 'COMPLETED'
  )
    return false;

  if (!facts.hasVariants)
    return (
      facts.inventoryStatus === 'COMPLETED' &&
      facts.physicalProfile !== undefined &&
      isPhysicalProfileComplete(facts.physicalProfile)
    );

  if (
    facts.physicalProfile !== undefined ||
    facts.inventoryStatus !== undefined
  )
    return false;

  const activeVariants = (facts.variants ?? []).filter(
    (variant) => variant.status === 'ACTIVA',
  );
  return (
    activeVariants.length > 0 &&
    activeVariants.every((variant) => canActivateVariant(true, variant))
  );
}

export function parentStatusAfterVariantDeactivation(
  parentStatus: ProductStatus,
  remainingActiveVariantCount: number,
): ProductStatus {
  if (
    !Number.isInteger(remainingActiveVariantCount) ||
    remainingActiveVariantCount < 0
  )
    throw new RangeError(
      'remainingActiveVariantCount must be a non-negative integer',
    );

  return parentStatus === 'ACTIVO' && remainingActiveVariantCount === 0
    ? 'INACTIVO'
    : parentStatus;
}

export interface PreparationState {
  status: PreparationStatus;
  manualRetryAllowed: boolean;
  operationId: string;
}

export interface PreparationRetry {
  state: 'PENDING';
  manualRetryAllowed: false;
  operationId: string;
  messageId: string;
}

export function prepareManualRetry(
  preparation: PreparationState,
  messageId: string,
): PreparationRetry | null {
  if (
    preparation.status === 'COMPLETED' ||
    !preparation.manualRetryAllowed ||
    messageId.length === 0
  )
    return null;

  return {
    state: 'PENDING',
    manualRetryAllowed: false,
    operationId: preparation.operationId,
    messageId,
  };
}
