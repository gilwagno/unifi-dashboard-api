import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

// Helper pra simular a aba entrando/saindo de segundo plano — jsdom não
// implementa Page Visibility de verdade, então mockamos `visibilityState` e
// disparamos o evento manualmente, como o browser faria.
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback at the given interval', () => {
    const callback = vi.fn();
    renderHook(() => usePolling(callback, 1000));

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('clears the timer on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => usePolling(callback, 1000));

    unmount();
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });

  // Regressão: o cleanup precisa remover o listener de `visibilitychange`, não só o
  // `setInterval`. Sem isso o listener sobrevive ao unmount e cada página que o usuário
  // visitou continua disparando uma requisição a cada vez que a aba volta pro primeiro plano
  // — acumulando um listener por navegação e chamando `setState` em componente desmontado.
  it('removes the visibilitychange listener on unmount (não só o timer)', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => usePolling(callback, 1000));

    unmount();
    setVisibility('hidden');
    setVisibility('visible');

    expect(callback).not.toHaveBeenCalled();
  });

  it('pauses while the tab is hidden and resumes with an immediate call when it becomes visible again', () => {
    const callback = vi.fn();
    renderHook(() => usePolling(callback, 1000));

    setVisibility('hidden');
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();

    setVisibility('visible');
    // A volta pra visível dispara uma chamada imediata, sem esperar o próximo tick.
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('always uses the latest callback, not the one from the first render (no stale closure)', () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { rerender } = renderHook(({ cb }) => usePolling(cb, 1000), {
      initialProps: { cb: firstCallback },
    });

    rerender({ cb: secondCallback });

    vi.advanceTimersByTime(1000);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);
  });

  it('does not run when enabled is false', () => {
    const callback = vi.fn();
    renderHook(() => usePolling(callback, 1000, { enabled: false }));

    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });
});
