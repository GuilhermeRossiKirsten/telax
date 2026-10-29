type GetDisplayMedia = (options: DisplayMediaStreamOptions) => Promise<MediaStream>;

/**
 * Pede a tela com o som da aba. `systemAudio: 'exclude'` deixa de fora o áudio do sistema, que na tela inteira
 * inclui as vozes da própria chamada (os outros ouviriam a si mesmos de volta). Navegadores que não aceitam
 * as opções de áudio (ex.: Safari, TypeError/NotSupportedError) recebem uma segunda tentativa só com vídeo.
 * Cancelamento (NotAllowedError, AbortError) e demais erros sobem sem nova tentativa.
 */
export async function captureScreen(getDisplayMedia: GetDisplayMedia): Promise<MediaStream> {
  try {
    // `systemAudio` ainda não está nos tipos do TypeScript
    return await getDisplayMedia({ video: true, audio: true, systemAudio: 'exclude' } as DisplayMediaStreamOptions);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name !== 'TypeError' && name !== 'NotSupportedError') throw e;
    return getDisplayMedia({ video: true, audio: false });
  }
}
