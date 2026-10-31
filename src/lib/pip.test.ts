import { describe, expect, it, vi } from 'vitest';
import { isInPip, pipSupported, togglePip, type PipDoc, type PipVideo } from './pip';

const video = (extra: Partial<PipVideo> = {}): PipVideo => ({ requestPictureInPicture: vi.fn(async () => ({})), ...extra }) as PipVideo;
const doc = (extra: Partial<PipDoc> = {}): PipDoc => ({ pictureInPictureEnabled: true, pictureInPictureElement: null, exitPictureInPicture: vi.fn(async () => {}), ...extra });

describe('pipSupported', () => {
  it('é verdadeiro quando o navegador permite e o vídeo oferece a API', () => {
    expect(pipSupported(doc(), video())).toBe(true);
  });

  it('é falso quando o documento não habilita PiP (Firefox, política do navegador)', () => {
    expect(pipSupported(doc({ pictureInPictureEnabled: false }), video())).toBe(false);
    expect(pipSupported(doc({ pictureInPictureEnabled: undefined }), video())).toBe(false);
  });

  it('é falso quando o vídeo não tem requestPictureInPicture', () => {
    expect(pipSupported(doc(), video({ requestPictureInPicture: undefined }))).toBe(false);
  });

  it('é falso quando o vídeo proíbe PiP (disablePictureInPicture)', () => {
    expect(pipSupported(doc(), video({ disablePictureInPicture: true }))).toBe(false);
  });
});

describe('isInPip', () => {
  it('só este vídeo conta: outro elemento em PiP não acende o botão', () => {
    const v = video();
    expect(isInPip(doc({ pictureInPictureElement: v as unknown as Element }), v)).toBe(true);
    expect(isInPip(doc({ pictureInPictureElement: video() as unknown as Element }), v)).toBe(false);
    expect(isInPip(doc(), v)).toBe(false);
  });
});

describe('togglePip', () => {
  it('fora do PiP, pede PiP para este vídeo', async () => {
    const v = video();
    await expect(togglePip(doc(), v)).resolves.toBe('entered');
    expect(v.requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it('já em PiP, sai dele (e não pede de novo)', async () => {
    const v = video();
    const d = doc({ pictureInPictureElement: v as unknown as Element });
    await expect(togglePip(d, v)).resolves.toBe('exited');
    expect(d.exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(v.requestPictureInPicture).not.toHaveBeenCalled();
  });

  it('com outro vídeo em PiP, este assume o lugar (o navegador só mantém uma janela)', async () => {
    const outro = video();
    const v = video();
    const d = doc({ pictureInPictureElement: outro as unknown as Element });
    await expect(togglePip(d, v)).resolves.toBe('entered');
    expect(v.requestPictureInPicture).toHaveBeenCalledTimes(1);
    expect(d.exitPictureInPicture).not.toHaveBeenCalled();
  });

  it('sem suporte, não tenta nada e diz "unsupported"', async () => {
    const v = video({ requestPictureInPicture: undefined });
    const d = doc({ pictureInPictureEnabled: false });
    await expect(togglePip(d, v)).resolves.toBe('unsupported');
    expect(d.exitPictureInPicture).not.toHaveBeenCalled();
  });

  it('recusa do navegador (vídeo sem quadros, sem gesto do usuário) vira "failed", sem lançar', async () => {
    const v = video({ requestPictureInPicture: vi.fn(async () => Promise.reject(new DOMException('x', 'InvalidStateError'))) });
    await expect(togglePip(doc(), v)).resolves.toBe('failed');
  });

  it('falha ao sair também vira "failed", sem lançar', async () => {
    const v = video();
    const d = doc({ pictureInPictureElement: v as unknown as Element, exitPictureInPicture: vi.fn(async () => Promise.reject(new Error('x'))) });
    await expect(togglePip(d, v)).resolves.toBe('failed');
  });
});

describe('togglePip: vídeo que ainda não carregou', () => {
  /** Vídeo que só fica pronto (readyState 1) quando o teste dispara `loadedmetadata`. */
  function loadingVideo() {
    let ready: (() => void) | undefined;
    const request = vi.fn(async () => {
      if (v.readyState === 0) throw new DOMException('sem metadados', 'InvalidStateError');
      return {};
    });
    const v = {
      readyState: 0,
      requestPictureInPicture: request,
      addEventListener: (_t: string, cb: () => void) => {
        ready = cb;
      },
      removeEventListener: () => {},
    } as unknown as PipVideo & { readyState: number };
    return { v, request, load: () => { v.readyState = 1; ready?.(); } };
  }

  it('espera os metadados em vez de falhar em silêncio quando o clique vem logo que a tela abre', async () => {
    const { v, request, load } = loadingVideo();
    const result = togglePip(doc(), v);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled(); // ainda esperando
    load();
    await expect(result).resolves.toBe('entered');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('desiste depois do prazo: tenta, o navegador recusa e o resultado é "failed" (sem travar)', async () => {
    const { v } = loadingVideo();
    await expect(togglePip(doc(), v, 20)).resolves.toBe('failed');
  });

  it('vídeo já pronto não espera nada', async () => {
    const { v, request } = loadingVideo();
    v.readyState = 4;
    await expect(togglePip(doc(), v)).resolves.toBe('entered');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
