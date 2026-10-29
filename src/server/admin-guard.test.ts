import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signAdminSession } from './admin-auth';

/**
 * NEGAR POR PADRÃO. Este teste é a garantia estrutural de que NENHUM endpoint de admin existe sem o filtro:
 *  - varre TODOS os `route.ts` de `src/app/api/admin/**` (por sistema de arquivos E por import, e exige que as duas listas batam);
 *  - exige que todo método exportado venha de `adminRoute(...)` (lendo o código-fonte);
 *  - chama cada método exportado sem sessão, com sessão forjada, de outro usuário, de outra origem e com o admin desligado,
 *    e exige a recusa certa SEM jamais encostar no store.
 * Uma rota nova esquecida sem o filtro deixa a suíte vermelha.
 */

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'cs', ADMIN_GITHUB_USER: 'dono', ADMIN_SESSION_SECRET: SECRET };
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** As ÚNICAS rotas sob /api/admin que não passam por `adminRoute`: criam ou encerram a sessão. Lista explícita e fechada. */
const SESSION_ROUTES = new Set(['auth/callback/route.ts', 'auth/login/route.ts', 'auth/logout/route.ts']);

const API_DIR = join(process.cwd(), 'src', 'app', 'api');
const ADMIN_DIR = join(API_DIR, 'admin');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (file: string, base: string) => relative(base, file).split(sep).join('/');

const routeFiles = walk(ADMIN_DIR).filter((f) => f.endsWith(`${sep}route.ts`)).map((f) => rel(f, ADMIN_DIR)).sort();

// por import: cada módulo carregado de verdade (o teste de código-fonte abaixo cobre o que o import não enxerga)
const modules = import.meta.glob('../app/api/admin/**/route.ts', { eager: true }) as Record<string, Record<string, unknown>>;
const loaded = new Map(Object.entries(modules).map(([k, v]) => [k.replace('../app/api/admin/', ''), v]));

const store = new Proxy({}, { get: (_t, prop) => { touched.push(String(prop)); return () => undefined; } });
const touched: string[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  touched.length = 0;
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = store;
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = undefined;
});

const sessionFor = (login: string, secret = SECRET) =>
  `${SESSION_COOKIE}=${signAdminSession({ login, id: 1, exp: Date.now() + 3_600_000 }, secret)}`;

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const params = Promise.resolve({ room: 'sala', id: `ip-${'a'.repeat(20)}` });
const call = (h: Handler, method: string, headers: Record<string, string> = {}) =>
  h(new Request('http://app.test/api/admin/x', { method, headers: { host: 'app.test', ...headers }, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' }), { params });

/** Todos os (arquivo, método) das rotas PROTEGIDAS (tudo menos as 3 de sessão). */
const protectedHandlers = [...loaded.entries()]
  .filter(([file]) => !SESSION_ROUTES.has(file))
  .flatMap(([file, mod]) => METHODS.filter((m) => typeof mod[m] === 'function').map((m) => ({ file, method: m, handler: mod[m] as Handler })));

describe('descoberta das rotas de admin', () => {
  it('existem rotas (a varredura não está vazia por engano)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(13);
    expect(protectedHandlers.length).toBeGreaterThanOrEqual(11);
  });

  it('o sistema de arquivos e o import enxergam EXATAMENTE as mesmas rotas', () => {
    expect([...loaded.keys()].sort()).toEqual(routeFiles);
  });

  it('as rotas de sessão são só as três declaradas e todas existem', () => {
    for (const f of SESSION_ROUTES) expect(routeFiles).toContain(f);
    expect(SESSION_ROUTES.size).toBe(3);
  });
});

describe('TODO método exportado vem de adminRoute (leitura do código-fonte)', () => {
  it.each(routeFiles.filter((f) => !SESSION_ROUTES.has(f)))('%s', (file) => {
    const src = readFileSync(join(ADMIN_DIR, file), 'utf8');
    const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:const|function|let|var)\s+(\w+)/g)].map((m) => m[1]);
    const methods = exported.filter((n) => (METHODS as readonly string[]).includes(n));
    expect(methods.length, 'a rota não exporta nenhum método HTTP').toBeGreaterThan(0);
    for (const m of methods) {
      expect(src, `${file}: ${m} precisa ser criado por adminRoute(...)`).toMatch(new RegExp(`export\\s+const\\s+${m}\\s*=\\s*adminRoute\\s*(?:<[^>]*>)?\\s*\\(`));
    }
    // nada de esconder handler em re-export, export default ou função solta
    expect(src, 'export default não é permitido').not.toMatch(/export\s+default/);
    expect(src, 'export { ... } não é permitido').not.toMatch(/export\s*\{/);
    expect(src, 'export * não é permitido').not.toMatch(/export\s*\*/);
    expect(src).not.toMatch(/export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
  });
});

describe('o filtro de verdade, em TODO método de TODA rota protegida', () => {
  it.each(protectedHandlers.map((h) => [`${h.method} ${h.file}`, h] as const))('%s', async (_name, { method, handler }) => {
    // 1) sem sessão → 401 (mesmo com Origin do mesmo site: é a autenticação que recusa)
    const noSession: Array<Record<string, string>> = [{}, { origin: 'http://app.test' }, { origin: 'https://evil.test' }];
    for (const headers of noSession) {
      const res = await call(handler, method, headers);
      expect(res.status, 'sem cookie').toBe(401);
    }
    // 2) cookies lixo / assinatura de outro segredo / expirado → 401
    const forged = sessionFor('dono', 'outro-segredo-bem-longo-e-totalmente-diferente');
    const expired = `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 1, exp: Date.now() - 1 }, SECRET)}`;
    for (const cookie of [`${SESSION_COOKIE}=lixo`, `${SESSION_COOKIE}=a.b`, forged, expired, 'outro=1']) {
      expect((await call(handler, method, { cookie, origin: 'http://app.test' })).status, cookie.slice(0, 20)).toBe(401);
    }
    // 3) assinatura certa, mas de OUTRO usuário → 403
    expect((await call(handler, method, { cookie: sessionFor('invasor'), origin: 'http://app.test' })).status).toBe(403);
    // 4) admin válido, método mutante, outra origem ou sem origem → 403 bad_origin
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const wrongOrigin: Array<Record<string, string>> = [{ origin: 'https://evil.test' }, {}, { origin: 'null' }, { referer: 'https://evil.test/' }];
      for (const headers of wrongOrigin) {
        const res = await call(handler, method, { cookie: sessionFor('dono'), ...headers });
        expect(res.status, 'origem').toBe(403);
        expect(await res.json()).toEqual({ error: 'bad_origin' });
      }
    }
    // 5) admin DESLIGADO (variável faltando) → 503, mesmo com cookie perfeito
    delete process.env.ADMIN_SESSION_SECRET;
    expect((await call(handler, method, { cookie: sessionFor('dono'), origin: 'http://app.test' })).status).toBe(503);
    expect((await call(handler, method, {})).status).toBe(503);
    // e em NENHUM dos casos o store foi tocado
    expect(touched).toEqual([]);
  });
});

describe('as 3 rotas de sessão (exceção explícita) também não abrem nada', () => {
  const sessionHandlers = [...SESSION_ROUTES].flatMap((file) =>
    METHODS.filter((m) => typeof loaded.get(file)?.[m] === 'function').map((m) => ({ file, method: m, handler: loaded.get(file)![m] as Handler })),
  );

  it('só exportam o método esperado', () => {
    expect(sessionHandlers.map((h) => `${h.method} ${h.file}`).sort()).toEqual([
      'GET auth/callback/route.ts',
      'GET auth/login/route.ts',
      'POST auth/logout/route.ts',
    ]);
  });

  it('sem sessão elas NÃO dão acesso a dados: só redirecionam, recusam ou apagam o cookie, e nunca tocam o store', async () => {
    for (const { handler, method, file } of sessionHandlers) {
      const res = await call(handler, method, {});
      expect([302, 403, 503], `${method} ${file}`).toContain(res.status);
      expect(res.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=ey`); // nenhuma sessão criada
    }
    expect(touched).toEqual([]);
  });

  it('o logout recusa outra origem (anti-CSRF)', async () => {
    const logout = sessionHandlers.find((h) => h.file === 'auth/logout/route.ts')!;
    expect((await call(logout.handler, 'POST', { origin: 'https://evil.test' })).status).toBe(403);
  });
});

describe('caminhos de controle FORA de /api/admin', () => {
  const FORBIDDEN_OUTSIDE = /\.(listRooms|getRoom|kick|closeRoom|reopenRoom|broadcast|command|ban|banPeer|listBans|unban)\s*\(/;

  it('nenhuma rota pública chama os métodos de administração do store', () => {
    const publicRoutes = walk(API_DIR).filter((f) => f.endsWith(`${sep}route.ts`) && !f.startsWith(ADMIN_DIR));
    expect(publicRoutes.length).toBeGreaterThan(0);
    for (const f of publicRoutes) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${rel(f, API_DIR)} chama um método de admin do store`).not.toMatch(FORBIDDEN_OUTSIDE);
    }
  });

  it('nenhum código de navegador (componentes, hooks, lib, páginas) importa @/server: o store e o filtro nunca vão para o cliente', () => {
    const src = join(process.cwd(), 'src');
    const clientDirs = ['components', 'hooks', 'lib'].map((d) => join(src, d));
    const pages = walk(join(src, 'app')).filter((f) => !f.startsWith(API_DIR));
    const files = [...clientDirs.flatMap(walk), ...pages].filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes('.test.'));
    expect(files.length).toBeGreaterThan(10);
    const importsServer = /from\s+['"](?:@\/server\/|(?:\.\.?\/)+server\/)/;
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), rel(f, src)).not.toMatch(importsServer);
    }
  });
});
