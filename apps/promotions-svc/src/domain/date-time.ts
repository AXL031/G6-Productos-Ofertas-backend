export function validInstant(value: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    Number(m[4]) < 24 &&
    Number(m[5]) < 60 &&
    Number(m[6]) < 60 &&
    Number(m[7] ?? 0) < 24 &&
    Number(m[8] ?? 0) < 60
  );
}
