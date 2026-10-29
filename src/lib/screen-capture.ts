type GetDisplayMedia = (options: DisplayMediaStreamOptions) => Promise<MediaStream>;

export type CaptureOptions = {
  /** inclui o áudio do sistema (tela inteira); desligado por padrão porque traz as vozes da própria chamada (eco) */
  systemAudio?: boolean;
};

/**
 * Pede a tela com o som da aba. Por padrão `systemAudio: 'exclude'` deixa de fora o áudio do sistema, que na tela
 * inteira inclui as vozes da própria chamada (os outros ouviriam a si mesmos de volta); quem liga a opção nas
 * Configurações recebe `'include'` e escolhe usar fone. Navegadores que não aceitam
 * as opções de áudio (ex.: Safari, TypeError/NotSupportedError) recebem uma segunda tentativa só com vídeo.
 * Cancelamento (NotAllowedError, AbortError) e demais erros sobem sem nova tentativa.
 */
export async function captureScreen(getDisplayMedia: GetDisplayMedia, opts: CaptureOptions = {}): Promise<MediaStream> {
  try {
    // `systemAudio` ainda não está nos tipos do TypeScript
    const systemAudio = opts.systemAudio ? 'include' : 'exclude';
    return await getDisplayMedia({ video: true, audio: true, systemAudio } as DisplayMediaStreamOptions);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name !== 'TypeError' && name !== 'NotSupportedError') throw e;
    return getDisplayMedia({ video: true, audio: false });
  }
}
