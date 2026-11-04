-- DISPOSABLE TEST FIXTURE ONLY. Not a migration or an approved shared change.
-- Install as po_promotions_owner exclusively in the runner's new local database.
-- Column UPDATE satisfies PostgreSQL's row-lock privilege check; statement guards
-- forbid actual mutations, including zero-row UPDATE and inherited seed access.
CREATE FUNCTION promotions.test_seed_append_only_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  seed_role oid := pg_catalog.to_regrole('po_promotions_seed');
BEGIN
  IF seed_role IS NULL THEN
    RAISE EXCEPTION 'SEED_ROLE_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.pg_has_role(current_user,seed_role,'USAGE')
     OR pg_catalog.pg_has_role(session_user,seed_role,'MEMBER') THEN
    RAISE EXCEPTION 'SEED_APPEND_ONLY' USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION promotions.test_seed_append_only_guard() FROM PUBLIC;

CREATE TRIGGER test_seed_append_only_guard
BEFORE UPDATE OR DELETE OR TRUNCATE ON promotions.promotions
FOR EACH STATEMENT EXECUTE FUNCTION promotions.test_seed_append_only_guard();
CREATE TRIGGER test_seed_append_only_guard
BEFORE UPDATE OR DELETE OR TRUNCATE ON promotions.recommendation_rules
FOR EACH STATEMENT EXECUTE FUNCTION promotions.test_seed_append_only_guard();

-- Never deploy either grant without the guards and a reviewed privilege audit.
GRANT UPDATE(id) ON promotions.promotions TO po_promotions_seed;
GRANT UPDATE(id) ON promotions.recommendation_rules TO po_promotions_seed;
