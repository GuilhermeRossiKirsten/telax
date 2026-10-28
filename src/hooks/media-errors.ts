export function describeMediaError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permissão de câmera/microfone negada. Libere o acesso no navegador para que os outros te vejam e ouçam.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Nenhum dispositivo de câmera/microfone encontrado.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Câmera ou microfone já está em uso por outro aplicativo.';
    default:
      return 'Não foi possível acessar câmera e microfone.';
  }
}
