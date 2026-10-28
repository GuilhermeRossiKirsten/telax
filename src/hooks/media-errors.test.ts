import { describe, expect, it } from 'vitest';
import { describeMediaError } from './media-errors';

const named = (name: string) => Object.assign(new Error(name), { name });

describe('describeMediaError', () => {
  it('NotAllowedError → permissão negada', () => {
    expect(describeMediaError(named('NotAllowedError'))).toMatch(/permiss/i);
  });
  it('NotFoundError → nenhum dispositivo', () => {
    expect(describeMediaError(named('NotFoundError'))).toMatch(/dispositivo|encontrad/i);
  });
  it('NotReadableError → dispositivo em uso', () => {
    expect(describeMediaError(named('NotReadableError'))).toMatch(/em uso|ocupad/i);
  });
  it('qualquer outro erro → mensagem genérica', () => {
    expect(describeMediaError(new Error('x'))).toMatch(/não foi possível/i);
    expect(describeMediaError('texto')).toMatch(/não foi possível/i);
  });
});
