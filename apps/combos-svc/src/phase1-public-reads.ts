/** Temporary academic Phase 1 exception authorized by the operator on 2026-11-06.
 * Exact read routes only; explicit runtime selection, no inferred principal or IP.
 * Pricing prevalidation remains excluded until its real handler can be certified.
 */
export const PHASE1_PUBLIC_READS = [
  {
    operationId: 'obtenerCombo',
    method: 'GET',
    path: '/api/v1/combos/{comboId}',
  },
  {
    operationId: 'listarCombosAdmin',
    method: 'GET',
    path: '/api/v1/combos',
  },
  {
    operationId: 'consultarDisponibilidadCombo',
    method: 'GET',
    path: '/api/v1/combos/{comboId}/disponibilidad',
  },
] as const;

export const PHASE1_PUBLIC_OPERATION_IDS = new Set<string>(
  PHASE1_PUBLIC_READS.map((route) => route.operationId),
);

export interface Phase1Request {
  readonly method?: string;
  readonly path?: string;
  readonly headers: { readonly authorization?: unknown };
}

/** Only fixed GET dependency clients call this selector. */
export function usePublicDependencyReads(): boolean {
  return (
    process.env.G6_SECURITY_MODE === 'PUBLIC_READ_ONLY' &&
    (process.env.COMBOS_PUBLIC_READ_OPERATIONS ?? '')
      .split(',')
      .some((id) => PHASE1_PUBLIC_OPERATION_IDS.has(id.trim()))
  );
}

export function isPhase1PublicRead(
  request: Phase1Request,
  mode: string | undefined,
  enabled: readonly string[] = [],
  operationId?: string,
): boolean {
  if (
    mode !== 'PUBLIC_READ_ONLY' ||
    request.headers.authorization !== undefined
  )
    return false;
  const path = request.path;
  if (!path || path.includes(String.fromCharCode(92)) || /%00/i.test(path))
    return false;
  const actual = path.split('/');
  try {
    if (actual.some((part) => ['.', '..'].includes(decodeURIComponent(part))))
      return false;
  } catch {
    return false;
  }
  return PHASE1_PUBLIC_READS.some((route) => {
    const expected = route.path.split('/');
    return (
      request.method === route.method &&
      enabled.includes(route.operationId) &&
      (operationId === undefined || route.operationId === operationId) &&
      expected.length === actual.length &&
      expected.every((part, index) =>
        part.startsWith('{')
          ? actual[index].length > 0 &&
            (part === '{sku}' || !/%2f|%5c/i.test(actual[index]))
          : part === actual[index],
      )
    );
  });
}
