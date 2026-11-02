import { isAllowedDemoGatewayIp } from './combos-demo-origin.js';

describe('isAllowedDemoGatewayIp', () => {
  it('matches only configured TCP source addresses, including IPv4-mapped loopback', () => {
    expect(isAllowedDemoGatewayIp('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(
      true,
    );
    expect(isAllowedDemoGatewayIp('127.0.0.1', ['::ffff:127.0.0.1'])).toBe(
      true,
    );
    expect(isAllowedDemoGatewayIp('203.0.113.10', ['127.0.0.1'])).toBe(false);
    expect(isAllowedDemoGatewayIp(undefined, ['127.0.0.1'])).toBe(false);
  });
});
