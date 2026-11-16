-- Read-only aggregate observation. Never exports messages, identities or payloads.
-- Run as pricing_app against the explicitly selected pilot database.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT count(*) FILTER (WHERE sent_at IS NULL) AS pending,
       count(*) FILTER (WHERE sent_at IS NULL AND attempts > 0) AS retrying,
       count(*) FILTER (WHERE sent_at IS NULL AND lease_until < clock_timestamp()) AS expired_leases,
       coalesce(extract(epoch FROM clock_timestamp() - min(created_at) FILTER (WHERE sent_at IS NULL)), 0)::bigint AS oldest_pending_seconds,
       coalesce(max(attempts) FILTER (WHERE sent_at IS NULL), 0) AS max_pending_attempts
FROM pricing.outbox_delivery;
ROLLBACK;
