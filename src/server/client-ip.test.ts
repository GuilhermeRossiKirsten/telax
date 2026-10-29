import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

const h = (o: Record<string, string>) => new Headers(o);

describe('clientIp', () => {
  it('usa o primeiro item de x-forwarded-for (o cliente original, antes dos proxies)', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe('203.0.113.7');
    expect(clientIp(h({ 'x-forwarded-for': '  198.51.100.4  ' }))).toBe('198.51.100.4');
  });

  it('sem x-forwarded-for cai em x-real-ip; sem nenhum devolve "unknown"', () => {
    expect(clientIp(h({ 'x-real-ip': '192.0.2.9' }))).toBe('192.0.2.9');
    expect(clientIp(h({}))).toBe('unknown');
  });

  it('o x-forwarded-for tem prioridade sobre o x-real-ip', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '192.0.2.9' }))).toBe('203.0.113.7');
  });

  it('aceita IPv6, normaliza maiúsculas e IPv4 mapeado em IPv6', () => {
    expect(clientIp(h({ 'x-forwarded-for': '2001:DB8::1' }))).toBe('2001:db8::1');
    expect(clientIp(h({ 'x-forwarded-for': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('tira a porta de um IPv4 com porta', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.7:51234' }))).toBe('203.0.113.7');
  });

  it('lixo, texto livre e tentativas de injeção não viram IP: "unknown" (ou o próximo cabeçalho válido)', () => {
    expect(clientIp(h({ 'x-forwarded-for': 'não é ip' }))).toBe('unknown');
    expect(clientIp(h({ 'x-forwarded-for': '$where: 1' }))).toBe('unknown');
    expect(clientIp(h({ 'x-forwarded-for': '999.1.1.1' }))).toBe('unknown');
    expect(clientIp(h({ 'x-forwarded-for': 'x'.repeat(500) }))).toBe('unknown');
    expect(clientIp(h({ 'x-forwarded-for': 'lixo', 'x-real-ip': '192.0.2.9' }))).toBe('192.0.2.9');
  });
});
