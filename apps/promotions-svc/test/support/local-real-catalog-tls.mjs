// Disposable TLS termination only. The unmodified Catalog process supplies every
// status/body and still verifies the original bearer. No business responses here.
import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
createServer(
  {
    key: readFileSync('/test/server.key'),
    cert: readFileSync('/test/server.crt'),
  },
  (req, res) => {
    const upstream = request(
      {
        host: 'catalog-svc',
        port: 3001,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: 'catalog-svc:3001' },
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  },
).listen(4443, '0.0.0.0');
