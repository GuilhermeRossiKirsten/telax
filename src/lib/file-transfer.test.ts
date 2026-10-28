import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, FileAssembler, MAX_FILE_BYTES, sendFile, type FileHeader } from './file-transfer';

class FakeChannel extends EventTarget {
  sent: Array<string | ArrayBuffer> = [];
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = 'open';
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
}
const asChannel = (c: FakeChannel) => c as unknown as RTCDataChannel;

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const makeFile = (n: number, name = 'a.bin') => new File([bytes(n)], name, { type: 'application/octet-stream' });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('sendFile', () => {
  it('envia file-start, pedaços de 16 KB e file-end', async () => {
    const ch = new FakeChannel();
    await sendFile(asChannel(ch), makeFile(40 * 1024));
    expect(CHUNK_SIZE).toBe(16 * 1024);
    const [start, ...rest] = ch.sent;
    const end = rest.pop();
    expect(JSON.parse(start as string)).toMatchObject({
      type: 'file-start',
      header: { name: 'a.bin', size: 40 * 1024, mime: 'application/octet-stream' },
    });
    expect(rest.map((c) => (c as ArrayBuffer).byteLength)).toEqual([16384, 16384, 8192]);
    expect(JSON.parse(end as string).type).toBe('file-end');
  });

  it('rejeita arquivo maior que 25 MB sem enviar nada', async () => {
    const ch = new FakeChannel();
    const huge = { size: MAX_FILE_BYTES + 1, name: 'x', type: '' } as unknown as File;
    await expect(sendFile(asChannel(ch), huge)).rejects.toThrow('file_too_large');
    expect(ch.sent).toHaveLength(0);
  });

  it('com bufferedAmount alto espera bufferedamountlow antes de enviar pedaços', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 4 * 1024 * 1024;
    const done = sendFile(asChannel(ch), makeFile(20 * 1024));
    await tick();
    await tick();
    expect(ch.sent.filter((d) => typeof d !== 'string')).toHaveLength(0);
    ch.bufferedAmount = 0;
    ch.dispatchEvent(new Event('bufferedamountlow'));
    await done;
    expect(ch.sent.filter((d) => typeof d !== 'string')).toHaveLength(2);
  });

  it('canal fechado durante a espera rejeita em vez de travar', async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 4 * 1024 * 1024;
    const done = sendFile(asChannel(ch), makeFile(20 * 1024));
    await tick();
    ch.dispatchEvent(new Event('close'));
    await expect(done).rejects.toThrow('channel_closed');
  });

  it('dois envios no mesmo canal não se intercalam', async () => {
    const ch = new FakeChannel();
    await Promise.all([sendFile(asChannel(ch), makeFile(20 * 1024, 'um')), sendFile(asChannel(ch), makeFile(20 * 1024, 'dois'))]);
    const kinds = ch.sent.map((d) => (typeof d === 'string' ? JSON.parse(d).type : 'chunk'));
    expect(kinds).toEqual(['file-start', 'chunk', 'chunk', 'file-end', 'file-start', 'chunk', 'chunk', 'file-end']);
  });

  it('reporta progresso cumulativo em bytes', async () => {
    const ch = new FakeChannel();
    const progress: number[] = [];
    await sendFile(asChannel(ch), makeFile(40 * 1024), (n) => progress.push(n));
    expect(progress).toEqual([16384, 32768, 40960]);
  });
});

describe('FileAssembler', () => {
  it('remonta bytes idênticos e chama onDone uma vez', async () => {
    const ch = new FakeChannel();
    const done: Array<{ header: FileHeader; blob: Blob }> = [];
    const asm = new FileAssembler((f) => done.push(f));
    await sendFile(asChannel(ch), makeFile(40 * 1024, 'foto.png'));
    for (const d of ch.sent) asm.handle(d);
    expect(done).toHaveLength(1);
    expect(done[0].header.name).toBe('foto.png');
    expect(new Uint8Array(await done[0].blob.arrayBuffer())).toEqual(bytes(40 * 1024));
  });

  it('reporta progresso de recepção', async () => {
    const ch = new FakeChannel();
    const seen: Array<[number, number]> = [];
    const asm = new FileAssembler(() => {}, (_id, received, total) => seen.push([received, total]));
    await sendFile(asChannel(ch), makeFile(20 * 1024));
    for (const d of ch.sent) asm.handle(d);
    expect(seen).toEqual([
      [16384, 20480],
      [20480, 20480],
    ]);
  });

  it('ignora mensagens malformadas sem lançar', () => {
    const done: unknown[] = [];
    const asm = new FileAssembler((f) => done.push(f));
    expect(() => {
      asm.handle('isso não é json');
      asm.handle('{"type":"desconhecido"}');
      asm.handle('{"type":"file-start","header":{"id":1}}');
      asm.handle(new ArrayBuffer(10)); // pedaço sem file-start
      asm.handle('{"type":"file-end","id":"nada"}');
    }).not.toThrow();
    expect(done).toHaveLength(0);
  });

  it('descarta transferência que excede o tamanho declarado', () => {
    const done: unknown[] = [];
    const asm = new FileAssembler((f) => done.push(f));
    asm.handle(JSON.stringify({ type: 'file-start', header: { id: 'x', name: 'n', size: 10, mime: '' } }));
    asm.handle(new ArrayBuffer(11));
    asm.handle(JSON.stringify({ type: 'file-end', id: 'x' }));
    expect(done).toHaveLength(0);
  });

  it('rejeita cabeçalho que declara mais que 25 MB', () => {
    const done: unknown[] = [];
    const asm = new FileAssembler((f) => done.push(f));
    asm.handle(JSON.stringify({ type: 'file-start', header: { id: 'x', name: 'n', size: MAX_FILE_BYTES + 1, mime: '' } }));
    asm.handle(new ArrayBuffer(5));
    asm.handle(JSON.stringify({ type: 'file-end', id: 'x' }));
    expect(done).toHaveLength(0);
  });
});
