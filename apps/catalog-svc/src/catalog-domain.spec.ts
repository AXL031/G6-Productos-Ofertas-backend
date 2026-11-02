import {
  canActivateProduct,
  canActivateVariant,
  isPhysicalProfileComplete,
  isPhysicalProfileValid,
  parentStatusAfterVariantDeactivation,
  prepareManualRetry,
  type PhysicalProfile,
  type ProductActivationFacts,
} from './catalog-domain.js';

const completeProfile: PhysicalProfile = {
  pesoKg: 1.25,
  dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
};

const readyProduct = (
  overrides: Partial<ProductActivationFacts> = {},
): ProductActivationFacts => ({
  minimumDataValid: true,
  mastersValid: true,
  requiredAttributesComplete: true,
  imageValid: true,
  pricingStatus: 'COMPLETED',
  hasVariants: false,
  physicalProfile: completeProfile,
  inventoryStatus: 'COMPLETED',
  ...overrides,
});

describe('catalog domain activation rules', () => {
  it.each([
    'minimumDataValid',
    'mastersValid',
    'requiredAttributesComplete',
    'imageValid',
  ] as const)('requires %s for activation and active edits', (key) => {
    expect(canActivateProduct(readyProduct({ [key]: false }))).toBe(false);
  });
  it.each(['PENDING', 'REJECTED'] as const)(
    'rejects uncompleted preparation %s',
    (status) => {
      expect(canActivateProduct(readyProduct({ pricingStatus: status }))).toBe(
        false,
      );
      expect(
        canActivateProduct(readyProduct({ inventoryStatus: status })),
      ).toBe(false);
    },
  );
  it('forbids physical data and inventory readiness on a parent with variants', () => {
    const child = {
      status: 'ACTIVA' as const,
      skuAndCombinationValid: true,
      attributesAndImageValid: true,
      physicalProfile: completeProfile,
      inventoryStatus: 'COMPLETED' as const,
    };
    expect(
      canActivateProduct(
        readyProduct({ hasVariants: true, variants: [child] }),
      ),
    ).toBe(false);
    expect(
      canActivateProduct(
        readyProduct({
          hasVariants: true,
          physicalProfile: undefined,
          inventoryStatus: undefined,
          variants: [
            child,
            { ...child, status: 'INACTIVA', inventoryStatus: 'REJECTED' },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      canActivateProduct(
        readyProduct({
          hasVariants: true,
          physicalProfile: undefined,
          inventoryStatus: undefined,
          variants: [child, { ...child, inventoryStatus: 'PENDING' }],
        }),
      ),
    ).toBe(false);
  });
  it('accepts incomplete positive profile data for a draft but requires completeness to activate', () => {
    expect(isPhysicalProfileValid({ pesoKg: 1 })).toBe(true);
    expect(isPhysicalProfileComplete({ pesoKg: 1 })).toBe(false);
  });

  it.each(['pesoKg', 'largo', 'ancho', 'alto'] as const)(
    'validates partial and complete profiles for %s',
    (measurement) => {
      const profile = (value: number | null | undefined): PhysicalProfile =>
        measurement === 'pesoKg'
          ? { ...completeProfile, pesoKg: value }
          : {
              ...completeProfile,
              dimensionesCm: {
                ...completeProfile.dimensionesCm,
                [measurement]: value,
              },
            };
      for (const value of [undefined, null]) {
        expect(isPhysicalProfileValid(profile(value))).toBe(true);
        expect(isPhysicalProfileComplete(profile(value))).toBe(false);
        expect(
          canActivateProduct(readyProduct({ physicalProfile: profile(value) })),
        ).toBe(false);
      }
      for (const value of [0, -1, NaN, Infinity, -Infinity]) {
        expect(isPhysicalProfileValid(profile(value))).toBe(false);
        expect(isPhysicalProfileComplete(profile(value))).toBe(false);
      }
      for (const value of [Number.MIN_VALUE, 0.001, Number.MAX_VALUE]) {
        expect(isPhysicalProfileValid(profile(value))).toBe(true);
        expect(isPhysicalProfileComplete(profile(value))).toBe(true);
      }
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-positive or non-finite physical measurement (%s)',
    (value) => {
      expect(isPhysicalProfileValid({ pesoKg: value })).toBe(false);
    },
  );

  it('requires a complete profile and completed inventory for a simple product', () => {
    expect(canActivateProduct(readyProduct())).toBe(true);
    expect(
      canActivateProduct(readyProduct({ inventoryStatus: 'PENDING' })),
    ).toBe(false);
    expect(
      canActivateProduct(readyProduct({ physicalProfile: { pesoKg: 1 } })),
    ).toBe(false);
  });

  it('requires at least one prepared active variant without assigning a profile to its parent', () => {
    const activeVariant = {
      status: 'ACTIVA' as const,
      skuAndCombinationValid: true,
      attributesAndImageValid: true,
      physicalProfile: completeProfile,
      inventoryStatus: 'COMPLETED' as const,
    };
    expect(
      canActivateProduct(
        readyProduct({
          hasVariants: true,
          physicalProfile: undefined,
          inventoryStatus: undefined,
          variants: [activeVariant],
        }),
      ),
    ).toBe(true);
    expect(
      canActivateProduct(readyProduct({ hasVariants: true, variants: [] })),
    ).toBe(false);
  });

  it('allows variant activation before its parent is active', () => {
    expect(
      canActivateVariant(true, {
        skuAndCombinationValid: true,
        attributesAndImageValid: true,
        physicalProfile: completeProfile,
        inventoryStatus: 'COMPLETED',
      }),
    ).toBe(true);
    expect(
      canActivateVariant(false, {
        skuAndCombinationValid: true,
        attributesAndImageValid: true,
        physicalProfile: completeProfile,
        inventoryStatus: 'COMPLETED',
      }),
    ).toBe(false);
  });

  it('inactivates an active parent when its last active variant is deactivated', () => {
    expect(parentStatusAfterVariantDeactivation('ACTIVO', 0)).toBe('INACTIVO');
    expect(parentStatusAfterVariantDeactivation('ACTIVO', 1)).toBe('ACTIVO');
    expect(parentStatusAfterVariantDeactivation('BORRADOR', 0)).toBe(
      'BORRADOR',
    );
    expect(parentStatusAfterVariantDeactivation('INACTIVO', 0)).toBe(
      'INACTIVO',
    );
  });
});

describe('catalog preparation retry rules', () => {
  it('preserves operation identity and consumes manual retry permission', () => {
    expect(
      prepareManualRetry(
        {
          status: 'REJECTED',
          manualRetryAllowed: true,
          operationId: 'operation-1',
        },
        'message-2',
      ),
    ).toEqual({
      state: 'PENDING',
      manualRetryAllowed: false,
      operationId: 'operation-1',
      messageId: 'message-2',
    });
  });

  it.each([
    ['COMPLETED', true],
    ['PENDING', false],
    ['REJECTED', false],
  ] as const)(
    'does not retry %s when retry permission is %s',
    (status, allowed) => {
      expect(
        prepareManualRetry(
          { status, manualRetryAllowed: allowed, operationId: 'operation-1' },
          'message-2',
        ),
      ).toBeNull();
    },
  );
});
