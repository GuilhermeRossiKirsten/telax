import { describe, expect, it } from 'vitest';
import { diffPresence } from './presence';

describe('diffPresence', () => {
  it('conta quem entrou e quem saiu, ignorando o próprio id', () => {
    expect(diffPresence(['eu', 'a', 'b'], ['eu', 'a', 'c', 'd'], 'eu')).toEqual({ joined: 2, left: 1 });
  });
  it('sem mudança não há nada', () => {
    expect(diffPresence(['eu', 'a'], ['a', 'eu'], 'eu')).toEqual({ joined: 0, left: 0 });
  });
  it('o próprio id aparecendo ou sumindo não conta', () => {
    expect(diffPresence(['a'], ['eu', 'a'], 'eu')).toEqual({ joined: 0, left: 0 });
    expect(diffPresence(['eu', 'a'], ['a'], 'eu')).toEqual({ joined: 0, left: 0 });
  });
  it('várias entradas ou saídas de uma vez viram contagens (o toque é um só)', () => {
    expect(diffPresence(['eu'], ['eu', 'a', 'b', 'c'], 'eu')).toEqual({ joined: 3, left: 0 });
    expect(diffPresence(['eu', 'a', 'b', 'c'], ['eu'], 'eu')).toEqual({ joined: 0, left: 3 });
  });
  it('ids repetidos na lista não contam duas vezes', () => {
    expect(diffPresence([], ['a', 'a'], 'eu')).toEqual({ joined: 1, left: 0 });
  });
  it('sem selfId (ainda não entrou) todos contam', () => {
    expect(diffPresence([], ['a'], null)).toEqual({ joined: 1, left: 0 });
  });
});
