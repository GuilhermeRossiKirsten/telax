import { describe, expect, it } from 'vitest';
import { MAX_BATCH, MAX_CANDIDATE, MAX_SDP, parseSignal, parseSignalItems } from './signal-validation';

const cand = { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ab' };

describe('parseSignal aceita', () => {
  it('offer, answer, candidate e reset válidos', () => {
    expect(parseSignal({ gen: 0, kind: 'offer', sdp: 'v=0', sid: 7 })).toEqual({ gen: 0, kind: 'offer', sdp: 'v=0', sid: 7 });
    expect(parseSignal({ gen: 3, kind: 'answer', sdp: 'v=0' })).toEqual({ gen: 3, kind: 'answer', sdp: 'v=0' });
    expect(parseSignal({ gen: 1, kind: 'candidate', candidate: cand })).toEqual({ gen: 1, kind: 'candidate', candidate: cand });
    expect(parseSignal({ gen: 0, kind: 'reset' })).toEqual({ gen: 0, kind: 'reset' });
  });

  it('candidate com sdpMid/sdpMLineIndex/usernameFragment nulos ou ausentes', () => {
    const c = { candidate: 'x', sdpMid: null, sdpMLineIndex: null, usernameFragment: null };
    expect(parseSignal({ gen: 0, kind: 'candidate', candidate: c })).toEqual({ gen: 0, kind: 'candidate', candidate: c });
    expect(parseSignal({ gen: 0, kind: 'candidate', candidate: { candidate: '' } })).toEqual({
      gen: 0,
      kind: 'candidate',
      candidate: { candidate: '' },
    });
  });

  it('descarta campos desconhecidos em data e em candidate', () => {
    const out = parseSignal({ gen: 0, kind: 'candidate', evil: 1, candidate: { ...cand, extra: 'x' } });
    expect(out).toEqual({ gen: 0, kind: 'candidate', candidate: cand });
  });

  it('sdp e candidate no limite exato', () => {
    expect(parseSignal({ gen: 0, kind: 'offer', sdp: 'x'.repeat(MAX_SDP) })).not.toBeNull();
    expect(parseSignal({ gen: 0, kind: 'candidate', candidate: { candidate: 'x'.repeat(MAX_CANDIDATE) } })).not.toBeNull();
  });
});

describe('parseSignal rejeita', () => {
  it.each([
    ['não-objeto', 'oi'],
    ['null', null],
    ['array', []],
    ['gen negativo', { gen: -1, kind: 'offer' }],
    ['gen fracionário', { gen: 1.5, kind: 'offer' }],
    ['gen string', { gen: '1', kind: 'offer' }],
    ['gen ausente', { kind: 'offer' }],
    ['gen inseguro', { gen: 2 ** 53, kind: 'offer' }],
    ['kind desconhecido', { gen: 0, kind: 'hack' }],
    ['sid fracionário', { gen: 0, kind: 'offer', sid: 0.5 }],
    ['sid string', { gen: 0, kind: 'offer', sid: '1' }],
    ['sdp não-string', { gen: 0, kind: 'offer', sdp: 1 }],
    ['sdp > 32 KiB', { gen: 0, kind: 'offer', sdp: 'x'.repeat(MAX_SDP + 1) }],
    ['candidate não-objeto', { gen: 0, kind: 'candidate', candidate: 'x' }],
    ['candidate.candidate ausente', { gen: 0, kind: 'candidate', candidate: { sdpMid: '0' } }],
    ['candidate.candidate > 2048', { gen: 0, kind: 'candidate', candidate: { candidate: 'x'.repeat(MAX_CANDIDATE + 1) } }],
    ['sdpMid > 64', { gen: 0, kind: 'candidate', candidate: { candidate: 'x', sdpMid: 'm'.repeat(65) } }],
    ['sdpMid número', { gen: 0, kind: 'candidate', candidate: { candidate: 'x', sdpMid: 1 } }],
    ['sdpMLineIndex negativo', { gen: 0, kind: 'candidate', candidate: { candidate: 'x', sdpMLineIndex: -1 } }],
    ['sdpMLineIndex fracionário', { gen: 0, kind: 'candidate', candidate: { candidate: 'x', sdpMLineIndex: 0.5 } }],
    ['usernameFragment > 256', { gen: 0, kind: 'candidate', candidate: { candidate: 'x', usernameFragment: 'u'.repeat(257) } }],
  ])('%s', (_label, raw) => {
    expect(parseSignal(raw)).toBeNull();
  });
});

describe('parseSignalItems (lote de sinais)', () => {
  const item = (to: string, i = 0) => ({ to, data: { gen: 0, kind: 'candidate', candidate: { candidate: `c${i}` }, evil: 1 } });

  it('aceita de 1 a MAX_BATCH itens, reconstruindo cada sinal só com campos conhecidos', () => {
    expect(MAX_BATCH).toBe(50);
    const out = parseSignalItems([item('b', 0), item('c', 1)]);
    expect(out).toEqual([
      { to: 'b', data: { gen: 0, kind: 'candidate', candidate: { candidate: 'c0' } } },
      { to: 'c', data: { gen: 0, kind: 'candidate', candidate: { candidate: 'c1' } } },
    ]);
    expect(parseSignalItems(Array.from({ length: MAX_BATCH }, (_, i) => item('b', i)))).toHaveLength(MAX_BATCH);
  });

  it('rejeita lista vazia, longa demais, não-lista e itens malformados (tudo ou nada)', () => {
    expect(parseSignalItems([])).toBeNull();
    expect(parseSignalItems(Array.from({ length: MAX_BATCH + 1 }, (_, i) => item('b', i)))).toBeNull();
    for (const bad of [undefined, null, 'x', 1, {}, { to: 'b', data: item('b').data }]) expect(parseSignalItems(bad)).toBeNull();
    for (const badItem of [null, 'x', {}, { to: 'b' }, { data: item('b').data }, { to: '', data: item('b').data }, { to: 5, data: item('b').data }, { to: 'b', data: { gen: -1, kind: 'offer' } }]) {
      expect(parseSignalItems([item('b'), badItem])).toBeNull();
    }
  });
});
