import { useEffect, useRef } from 'react';

interface UsePollingOptions {
  /** Quando `false`, o polling fica completamente desligado (nenhum timer roda, nenhuma
   * chamada é disparada). Default: `true`. */
  enabled?: boolean;
}

/**
 * Dispara `callback` em intervalos regulares enquanto o componente estiver montado — pensado
 * pra reconsultar o backend em segundo plano (ex.: refletir mudanças feitas fora do dashboard,
 * como renomear um AP direto no controller UniFi) sem exigir F5 manual.
 *
 * Comportamento:
 * - Roda `callback()` a cada `intervalMs`, via `setInterval`, limpo no cleanup (unmount ou troca
 *   de `intervalMs`/`enabled`).
 * - Pausa automaticamente quando a aba fica em segundo plano (`document.visibilityState ===
 *   'hidden'`) — evita gastar requisição/rate limit do controller com uma aba que ninguém está
 *   olhando. Ao voltar a ficar visível, dispara uma chamada IMEDIATA (pra não ficar até
 *   `intervalMs` desatualizado) e retoma o intervalo normalmente.
 * - Sempre usa a versão mais recente de `callback` a cada tick, mesmo que o chamador não passe
 *   uma função estável (`useCallback`) — evita o closure-preso clássico de `setInterval` dentro
 *   de `useEffect` com dependência fixa.
 *
 * @param callback Função chamada a cada tick do polling (e imediatamente ao voltar de uma aba
 *   oculta). Não precisa ser memoizada pelo chamador.
 * @param intervalMs Intervalo entre chamadas, em milissegundos.
 * @param options.enabled Liga/desliga o polling (default `true`). Útil pra pausar quando a
 *   página tem um formulário aberto que não deveria ser perturbado por um refresh em segundo
 *   plano.
 * @returns void — o hook não expõe nenhum valor, só o efeito colateral do timer.
 */
export function usePolling(callback: () => void, intervalMs: number, options?: UsePollingOptions): void {
  const enabled = options?.enabled ?? true;
  const callbackRef = useRef(callback);

  // Atualizado depois de TODO commit (efeito sem array de dependências) — assim o próximo
  // tick do `setInterval` (ou a chamada imediata do listener de visibilidade) sempre vê a
  // versão mais recente do callback, mesmo que o chamador não a memoize. Escrever a ref aqui
  // e não durante o render é de propósito: render precisa ser puro (é o que a regra
  // `react(refs)` do oxlint cobra), e escrevendo no commit a ref nunca guarda o callback de
  // um render que o React descartou.
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        callbackRef.current();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      callbackRef.current();
    }, intervalMs);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
