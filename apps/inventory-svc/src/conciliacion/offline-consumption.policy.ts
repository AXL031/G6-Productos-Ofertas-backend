/**
 * Política interna de SPEC-015 §24.5 / DEC-F-013. No es un endpoint ni un DTO
 * público: la identidad de la venta, resolución de tienda y autorización
 * continúan pendientes de homologación (DEC-F-013/014/015).
 */
export function planOfflineConsumption(
  balance: Readonly<{ onHand: number; reserved: number; blocked: number }>,
  requestedQuantity: number,
): {
  onHand: number;
  appliedQuantity: number;
  unresolvedQuantity: number;
  requiresReview: boolean;
  recordMovement: boolean;
} {
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0) {
    throw new RangeError(
      'La cantidad solicitada debe ser un entero positivo seguro',
    );
  }
  if (
    !balance ||
    ![balance.onHand, balance.reserved, balance.blocked].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    balance.reserved + balance.blocked > balance.onHand
  ) {
    throw new RangeError('El saldo autoritativo no satisface sus invariantes');
  }
  const available = balance.onHand - balance.reserved - balance.blocked;
  const appliedQuantity = Math.min(requestedQuantity, available);
  const unresolvedQuantity = requestedQuantity - appliedQuantity;
  return {
    onHand: balance.onHand - appliedQuantity,
    appliedQuantity,
    unresolvedQuantity,
    requiresReview: unresolvedQuantity > 0,
    recordMovement: appliedQuantity > 0,
  };
}
