/**
 * Checks that a reference has the shape consumed by BulkStorageService and
 * points at its configured bucket. This does not establish bucket ACLs; the
 * storage adapter verifies that the configured bucket is private on writes.
 */
export function matchesBulkStorageReference(
  contentRef: string,
  bucket: string | undefined,
): boolean {
  if (!bucket) return false;
  const prefix = `supabase://${bucket}/`;
  if (!contentRef.startsWith(prefix)) return false;

  const objectName = contentRef.slice(prefix.length);
  return (
    objectName.length > 0 &&
    !/[\\?#\s]/.test(objectName) &&
    objectName
      .split('/')
      .every(
        (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
      )
  );
}
