// EXPLICIT TEST PROVIDER. Not G7 runtime, a grant, or external homologation.
// Published G7 bf819dd endpoints/DTOs only; signs synthetic user JWTs using the
// same disposable HTTPS JWKS consumed by the unmodified native services.
import { randomUUID } from 'node:crypto';

export const sessionFixturePassword = 'isolated-g7-password';
export function createG7SessionFixture(issueToken) {
  const users = new Map(
    ['manager', 'mfa', 'reader', 'renew', 'revoked'].map((name) => [
      name + '@example.test',
      {
        id: randomUUID(),
        name,
        nombreCompleto: name === 'reader' ? 'Lector E2E' : 'Gestora E2E',
        roles: [name === 'reader' ? 'CLIENTE' : 'GESTOR_COMERCIAL'],
      },
    ]),
  );
  const refreshes = new Map(),
    challenges = new Map();
  const secrets = new Set([sessionFixturePassword]);
  const counts = {
    login: 0,
    send: 0,
    verify: 0,
    refresh: 0,
    logout: 0,
    reuse: 0,
  };
  function session(user, initial = false, family = randomUUID()) {
    const accessToken = issueToken({
      sub: user.id,
      roles: user.roles,
      exp:
        initial && ['renew', 'revoked'].includes(user.name)
          ? 1
          : Math.floor(Date.now() / 1000) + 900,
    });
    const refreshToken = randomUUID();
    refreshes.set(refreshToken, { user, family, active: true });
    secrets.add(accessToken);
    secrets.add(refreshToken);
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      usuario: {
        id: user.id,
        nombreCompleto: user.nombreCompleto,
        correo: user.name + '@example.test',
        roles: user.roles,
      },
    };
  }
  const problem = (response, code) => {
    response.writeHead(401, { 'content-type': 'application/problem+json' });
    response.end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Prueba de sesión',
        status: 401,
        code,
      }),
    );
  };
  return {
    snapshot: () => ({ ...counts }),
    redact: (value) => {
      for (const secret of secrets)
        value = value.replaceAll(secret, '[synthetic-session-secret]');
      return value;
    },
    async handle(request, response) {
      const path = request.url;
      if (!path?.startsWith('/api/v1/auth/')) return false;
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return true;
      }
      let raw = '';
      for await (const part of request) {
        raw += part;
        if (raw.length > 16384) {
          response.writeHead(413).end();
          return true;
        }
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        response.writeHead(400).end();
        return true;
      }
      response.setHeader('content-type', 'application/json');
      if (path === '/api/v1/auth/login') {
        counts.login++;
        const user = users.get(body.correo);
        if (!user || body.contrasena !== sessionFixturePassword) {
          problem(response, 'CREDENCIALES_INVALIDAS');
          return true;
        }
        if (user.name === 'mfa') {
          const challengeToken = randomUUID();
          secrets.add(challengeToken);
          challenges.set(challengeToken, {
            user,
            sent: false,
            attempts: 0,
            expiresAt: Date.now() + 300000,
          });
          response.end(
            JSON.stringify({
              mfaRequerido: true,
              challengeToken,
              canal: 'EMAIL',
              expiraEn: 300,
            }),
          );
        } else response.end(JSON.stringify(session(user, true)));
      } else if (
        path === '/api/v1/auth/otp/solicitar' ||
        path === '/api/v1/auth/otp/verificar'
      ) {
        const challenge = challenges.get(body.challengeToken);
        if (!challenge || Date.now() >= challenge.expiresAt) {
          problem(response, 'TOKEN_INVALIDO');
          return true;
        }
        if (path.endsWith('/solicitar')) {
          counts.send++;
          challenge.sent = true;
          challenge.attempts = 0;
          response.writeHead(202).end(
            JSON.stringify({
              canal: 'EMAIL',
              destinoEnmascarado: 'm***@example.test',
              expiraEn: 300,
              desafioExpiraEn: Math.max(
                1,
                Math.floor((challenge.expiresAt - Date.now()) / 1000),
              ),
            }),
          );
        } else {
          counts.verify++;
          if (!challenge.sent || body.codigo !== '123456') {
            challenge.attempts++;
            if (challenge.attempts >= 3) challenge.sent = false;
            problem(
              response,
              challenge.attempts >= 3
                ? 'OTP_INTENTOS_AGOTADOS'
                : 'CODIGO_INVALIDO',
            );
          } else {
            challenges.delete(body.challengeToken);
            response.end(JSON.stringify(session(challenge.user)));
          }
        }
      } else if (path === '/api/v1/auth/refresh') {
        counts.refresh++;
        const previous = refreshes.get(body.refreshToken);
        if (!previous?.active || previous.user.name === 'revoked') {
          if (previous && !previous.active) counts.reuse++;
          if (previous)
            for (const item of refreshes.values())
              if (item.family === previous.family) item.active = false;
          problem(response, 'REFRESCO_INVALIDO');
        } else {
          previous.active = false;
          response.end(
            JSON.stringify(session(previous.user, false, previous.family)),
          );
        }
      } else if (path === '/api/v1/auth/logout') {
        counts.logout++;
        const previous = refreshes.get(body.refreshToken);
        if (previous)
          for (const item of refreshes.values())
            if (item.family === previous.family) item.active = false;
        response.writeHead(204).end();
      } else response.writeHead(404).end();
      return true;
    },
  };
}
