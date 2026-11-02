import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONTRACT_ROUTES } from './contract-routes.js';
import {
  GatewayFailure,
  GatewayIdentity,
  isDemoBypassRoute,
} from './gateway-identity.js';
import { GATEWAY_SETTINGS, type GatewaySettings } from './gateway-settings.js';
import type { ContractRoute } from './contract-route.js';
import { readLimitedResponse } from './bounded-response.js';
import { sendGatewayProblem } from './gateway-problem.js';
import { streamedRequest } from './streamed-request.js';
import { streamFileResponse } from './streamed-response.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routes = [...CONTRACT_ROUTES].sort(
  (a, b) =>
    (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0),
);

export function matchContractRoute(
  method: string,
  path: string,
): ContractRoute | undefined {
  if (/\\|%2f|%5c|%00/i.test(path)) return undefined;
  const actual = path.split('/');
  try {
    if (actual.some((value) => ['.', '..'].includes(decodeURIComponent(value))))
      return undefined;
  } catch {
    return undefined;
  }
  return routes.find(
    (route) =>
      route.method === method &&
      route.path.split('/').length === actual.length &&
      route.path
        .split('/')
        .every((part, i) =>
          part.startsWith('{') ? actual[i].length > 0 : part === actual[i],
        ),
  );
}

/** Demo requests are accepted only from the Gateway's private TCP peer. */
export function isRestrictedDemoPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  if (isIP(normalized) !== 6) return false;
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return normalized === '::1' || (first >= 0xfc00 && first <= 0xfdff);
}

async function readRequest(
  req: Request,
  max: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if ('rawBody' in req && Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (req.body !== undefined) return Buffer.from(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', fail);
      req.off('aborted', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = () => {
      cleanup();
      reject(new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE'));
    };
    const abort = () => {
      req.resume();
      fail();
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        req.resume();
        reject(new GatewayFailure(400, 'VALIDACION'));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    req.on('data', data);
    req.on('end', end);
    req.on('error', fail);
    req.on('aborted', fail);
  });
}

@Injectable()
export class GatewayProxy {
  constructor(
    @Inject(GATEWAY_SETTINGS) private readonly settings: GatewaySettings,
    private readonly identity: GatewayIdentity,
  ) {}

  async forward(req: Request, res: Response): Promise<void> {
    const path = req.originalUrl.split('?')[0];
    const route = matchContractRoute(req.method, path);
    if (!route) {
      res.status(404).end();
      return;
    }
    const incomingCorrelation = req.header('x-correlation-id');
    const correlationId =
      incomingCorrelation && uuid.test(incomingCorrelation)
        ? incomingCorrelation
        : randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', disconnected);
    let upload: ReturnType<typeof streamedRequest> | undefined;
    try {
      const bypass = isDemoBypassRoute(route, this.settings);
      if (bypass && !isRestrictedDemoPeer(req.socket.remoteAddress))
        throw new GatewayFailure(403, 'SCOPE_INSUFICIENTE');
      const uniqueHeaders = new Set([
        ...(!bypass ? ['authorization'] : []),
        'x-correlation-id',
        'idempotency-key',
        ...route.headers.map((h) => h.name),
      ]);
      for (const name of uniqueHeaders) {
        let count = 0;
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          if (req.rawHeaders[i].toLowerCase() === name) count++;
        if (count > 1) throw new GatewayFailure(400, 'VALIDACION');
      }
      if (incomingCorrelation && !uuid.test(incomingCorrelation))
        throw new GatewayFailure(400, 'VALIDACION');
      const authorization = bypass ? undefined : req.header('authorization');
      await this.identity.authorize(route, authorization);
      const base = this.settings.upstreams[route.service];
      if (!base) throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      const headers: Record<string, string> = {
        accept: req.header('accept') ?? 'application/json',
      };
      if (authorization) headers.authorization = authorization;
      for (const header of route.headers) {
        const value =
          header.name === 'x-correlation-id'
            ? correlationId
            : req.header(header.name);
        if (
          (header.required && !value) ||
          (value &&
            ((header.minLength !== undefined &&
              value.length < header.minLength) ||
              (header.maxLength !== undefined &&
                value.length > header.maxLength)))
        )
          throw new GatewayFailure(400, 'VALIDACION');
        if (value) headers[header.name] = value;
      }
      const contentType = req.header('content-type');
      if (contentType) {
        if (
          !route.requestTypes.includes(
            contentType.split(';')[0].trim().toLowerCase(),
          )
        )
          throw new GatewayFailure(400, 'VALIDACION');
        headers['content-type'] = contentType;
      }
      // File owners enforce their contractual limits (including brand logos).
      // The JSON buffer budget does not apply to multipart files or framing.
      const streamsMultipart = route.requestTypes.includes(
        'multipart/form-data',
      );
      let body: RequestInit['body'];
      if (streamsMultipart) {
        upload = streamedRequest(req);
        body = upload.body;
      } else {
        const buffered = await readRequest(
          req,
          this.settings.maxBytes,
          controller.signal,
        );
        if (buffered.length > this.settings.maxBytes)
          throw new GatewayFailure(400, 'VALIDACION');
        if (buffered.length && !['GET', 'HEAD'].includes(route.method))
          body = new Uint8Array(buffered).buffer;
      }
      const init: RequestInit & { duplex?: 'half' } = {
        method: route.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        body,
        ...(upload ? { duplex: 'half' as const } : {}),
      };
      const response = await fetch(new URL(req.originalUrl, base), init);
      const contractResponse = route.responses[String(response.status)];
      if (
        !contractResponse ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      }
      for (const header of contractResponse.headers) {
        const value = response.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (response.status >= 400) {
        const payload = await readLimitedResponse(
          response,
          this.settings.maxBytes,
        );
        if (upload && !req.readableEnded) {
          // Discard remaining bytes before ending the response: otherwise an
          // early 413 can reset a client still uploading a large multipart.
          upload.close();
          await finished(req, { signal: controller.signal, cleanup: true });
        }
        let code = '';
        try {
          const problem: unknown = JSON.parse(payload.toString('utf8'));
          if (
            problem &&
            typeof problem === 'object' &&
            'code' in problem &&
            typeof problem.code === 'string'
          )
            code = problem.code;
        } catch {
          /* Never forward raw upstream failures. */
        }
        sendGatewayProblem(
          res,
          route,
          response.status,
          code,
          correlationId,
          'provider',
        );
        return;
      }
      const responseType = response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase();
      if (
        response.status !== 204 &&
        (!responseType || !contractResponse.types.includes(responseType))
      )
        throw new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      if (responseType)
        res.setHeader('Content-Type', response.headers.get('content-type')!);
      if (responseType && responseType !== 'application/json') {
        res.status(response.status);
        await streamFileResponse(response, res, controller.signal);
        return;
      }
      const payload = await readLimitedResponse(
        response,
        this.settings.maxBytes,
      );
      res.status(response.status).send(payload);
    } catch (error: unknown) {
      const failure =
        error instanceof GatewayFailure
          ? error
          : new GatewayFailure(503, 'SERVICIO_NO_DISPONIBLE');
      if (!res.destroyed && !res.headersSent) {
        if (controller.signal.aborted) res.setHeader('Connection', 'close');
        sendGatewayProblem(
          res,
          route,
          failure.status,
          failure.code,
          correlationId,
          'gateway',
        );
      }
    } finally {
      clearTimeout(timer);
      res.off('close', disconnected);
      upload?.close();
    }
  }
}
