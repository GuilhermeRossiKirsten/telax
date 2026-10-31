/**
 * Picture-in-Picture da tela compartilhada: a imagem sai da página e vira uma janela flutuante, para a pessoa seguir a
 * apresentação enquanto usa outra aba ou programa. O navegador mantém UMA janela de cada vez (pedir outra troca a atual).
 * Tipos mínimos em vez do DOM completo, para testar em Node com fakes.
 */

export type PipDoc = {
  pictureInPictureEnabled?: boolean;
  pictureInPictureElement?: Element | null;
  exitPictureInPicture?(): Promise<void>;
};

export type PipVideo = Element & {
  requestPictureInPicture?(): Promise<unknown>;
  disablePictureInPicture?: boolean;
  /** 0 = ainda sem metadados: o navegador recusa o PiP até o vídeo carregar */
  readyState?: number;
};

/** Quanto esperar o vídeo carregar antes de desistir (a tela acabou de abrir e ainda não chegou o primeiro quadro). */
export const PIP_READY_WAIT_MS = 2000;

/** Resolve quando o vídeo tem metadados (ou no prazo, o que vier antes); vídeo já pronto não espera. */
function whenReady(video: PipVideo, ms: number): Promise<void> {
  if (typeof video.readyState !== 'number' || video.readyState > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    video.addEventListener('loadedmetadata', done);
  });
}

export type PipResult = 'entered' | 'exited' | 'unsupported' | 'failed';

/** O navegador oferece PiP e este vídeo pode usá-lo (Firefox desktop, por exemplo, não oferece). */
export function pipSupported(doc: PipDoc, video: PipVideo): boolean {
  return doc.pictureInPictureEnabled === true && typeof video.requestPictureInPicture === 'function' && video.disablePictureInPicture !== true;
}

/** Este vídeo é o que está na janela flutuante agora. */
export const isInPip = (doc: PipDoc, video: PipVideo): boolean => doc.pictureInPictureElement === video;

/** Entra no PiP, ou sai dele se este vídeo já está lá. Nunca lança: recusa do navegador vira `failed`. */
export async function togglePip(doc: PipDoc, video: PipVideo, readyWaitMs = PIP_READY_WAIT_MS): Promise<PipResult> {
  if (!pipSupported(doc, video)) return 'unsupported';
  try {
    if (isInPip(doc, video)) {
      await doc.exitPictureInPicture?.();
      return 'exited';
    }
    await whenReady(video, readyWaitMs);
    await video.requestPictureInPicture?.();
    return 'entered';
  } catch {
    return 'failed'; // sem gesto do usuário, vídeo sem quadros ainda, política do navegador…
  }
}
