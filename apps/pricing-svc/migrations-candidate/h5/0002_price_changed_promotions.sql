-- Add the R17 destination to the previously applied H5 outbox_delivery schema.
DO $guard$
BEGIN
  IF current_user <> 'po_pricing_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'pricing' AND pg_get_userbyid(nspowner) = current_user
  ) THEN RAISE EXCEPTION 'Run H5 migration as po_pricing_owner on pricing'; END IF;
END;
$guard$;

ALTER TABLE pricing.outbox_delivery
  DROP CONSTRAINT ck_delivery_route,
  ADD CONSTRAINT ck_delivery_route CHECK (
    route_version = 1
    AND destination IN ('g6.price-audit.from.pricing', 'g6.promotions.from.pricing')
    AND transport = 'AZURE_SERVICE_BUS'
  );
