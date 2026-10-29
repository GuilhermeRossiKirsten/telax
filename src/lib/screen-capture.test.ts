import { describe, expect, it, vi } from 'vitest';
import { captureScreen } from './screen-capture';

const stream = { id: 'tela' } as unknown as MediaStream;
const failure = (name: string) => Object.assign(new Error(name), { name });

describe('captureScreen', () => {
  it('pede vídeo e o áudio da aba, sem o áudio do sistema (que traria as vozes da própria chamada de volta)', async () => {
    const get = vi.fn().mockResolvedValue(stream);
    await expect(captureScreen(get)).resolves.toBe(stream);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ video: true, audio: true, systemAudio: 'exclude' });
  });

  it('com a opção ligada, pede também o áudio do sistema (tela inteira)', async () => {
    const get = vi.fn().mockResolvedValue(stream);
    await captureScreen(get, { systemAudio: true });
    expect(get).toHaveBeenCalledWith({ video: true, audio: true, systemAudio: 'include' });
  });

  it('opção desligada ou ausente continua pedindo exclude', async () => {
    const get = vi.fn().mockResolvedValue(stream);
    await captureScreen(get, { systemAudio: false });
    await captureScreen(get, {});
    expect(get).toHaveBeenNthCalledWith(1, { video: true, audio: true, systemAudio: 'exclude' });
    expect(get).toHaveBeenNthCalledWith(2, { video: true, audio: true, systemAudio: 'exclude' });
  });

  it('com a opção ligada, o retry em TypeError também cai para só vídeo', async () => {
    const get = vi.fn().mockRejectedValueOnce(failure('TypeError')).mockResolvedValueOnce(stream);
    await expect(captureScreen(get, { systemAudio: true })).resolves.toBe(stream);
    expect(get).toHaveBeenLastCalledWith({ video: true, audio: false });
  });

  it.each(['TypeError', 'NotSupportedError'])('se o navegador não aceita as opções (%s), tenta de novo só com vídeo', async (name) => {
    const get = vi.fn().mockRejectedValueOnce(failure(name)).mockResolvedValueOnce(stream);
    await expect(captureScreen(get)).resolves.toBe(stream);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith({ video: true, audio: false });
  });

  it.each(['NotAllowedError', 'AbortError', 'NotFoundError'])('%s é relançado sem nova tentativa', async (name) => {
    const get = vi.fn().mockRejectedValue(failure(name));
    await expect(captureScreen(get)).rejects.toMatchObject({ name });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('se a segunda tentativa também falhar, o erro dela é o que sobe', async () => {
    const get = vi.fn().mockRejectedValueOnce(failure('TypeError')).mockRejectedValueOnce(failure('NotAllowedError'));
    await expect(captureScreen(get)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
