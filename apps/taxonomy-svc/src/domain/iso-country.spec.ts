import { esPaisIso } from './iso-country.js';

describe('país ISO 3166-1 alpha-2', () => {
  it.each(['PE', 'EC', 'US', 'GB', 'AX'])('acepta %s', (code) =>
    expect(esPaisIso(code)).toBe(true),
  );
  it.each(['ZZ', 'XX', 'EU', 'UK', 'XK', 'SU', 'pe', ''])(
    'rechaza %s',
    (code) => expect(esPaisIso(code)).toBe(false),
  );
});
