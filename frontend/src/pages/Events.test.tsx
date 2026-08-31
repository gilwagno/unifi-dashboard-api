import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Events } from './Events';

vi.mock('../lib/api', () => ({
  api: {
    listSites: vi.fn(),
    eventsHistory: vi.fn(),
  },
  getAccessToken: () => null,
}));

import { api } from '../lib/api';

function renderEvents() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Events />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('Events page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
  });

  it('renders parsed.meta.message when present', async () => {
    vi.mocked(api.eventsHistory).mockResolvedValue({
      data: [
        {
          receivedAt: '2026-01-01T10:00:00.000Z',
          data: JSON.stringify({ meta: { message: 'Cliente conectado ao AP-01' } }),
        },
      ],
    });

    renderEvents();

    expect(await screen.findByText('Cliente conectado ao AP-01')).toBeInTheDocument();
  });

  it('falls back to a truncated JSON summary for an unknown schema without throwing', async () => {
    const unknownPayload = { foo: 'bar', nested: { x: 1 } };
    vi.mocked(api.eventsHistory).mockResolvedValue({
      data: [
        { receivedAt: '2026-01-01T10:00:00.000Z', data: JSON.stringify(unknownPayload) },
        {
          receivedAt: '2026-01-01T10:01:00.000Z',
          data: JSON.stringify({ meta: { message: 'Evento normal seguinte' } }),
        },
      ],
    });

    renderEvents();

    const expectedSummary = JSON.stringify(unknownPayload).slice(0, 120);
    expect(await screen.findByText(expectedSummary)).toBeInTheDocument();
    // The other list item must still render fine — one bad/unknown event
    // must not break rendering of the rest of the list.
    expect(await screen.findByText('Evento normal seguinte')).toBeInTheDocument();
  });

  it('falls back to the raw truncated string when the payload is not valid JSON', async () => {
    const raw = 'algo aconteceu, não é json';
    vi.mocked(api.eventsHistory).mockResolvedValue({
      data: [{ receivedAt: '2026-01-01T10:00:00.000Z', data: raw }],
    });

    renderEvents();

    expect(await screen.findByText(raw.slice(0, 160))).toBeInTheDocument();
  });

  it('does not break rendering when meta.message is not a string (object payload)', async () => {
    const weird = { meta: { message: { code: 7, detail: 'nested' } } };
    vi.mocked(api.eventsHistory).mockResolvedValue({
      data: [
        { receivedAt: '2026-01-01T10:00:00.000Z', data: JSON.stringify(weird) },
        {
          receivedAt: '2026-01-01T10:01:00.000Z',
          data: JSON.stringify({ meta: { message: 'Evento normal seguinte' } }),
        },
      ],
    });

    renderEvents();

    // Um payload com meta.message não-string não pode derrubar a lista inteira.
    expect(await screen.findByText('Evento normal seguinte')).toBeInTheDocument();
    expect(await screen.findByText(JSON.stringify(weird).slice(0, 120))).toBeInTheDocument();
  });

  it('does not break rendering when key/type are non-string values', async () => {
    const arrayKey = { key: ['a', 'b'] };
    vi.mocked(api.eventsHistory).mockResolvedValue({
      data: [
        { receivedAt: '2026-01-01T10:00:00.000Z', data: JSON.stringify(arrayKey) },
        { receivedAt: '2026-01-01T10:01:00.000Z', data: JSON.stringify({ type: 42 }) },
        { receivedAt: '2026-01-01T10:02:00.000Z', data: 'null' },
      ],
    });

    renderEvents();

    expect(await screen.findByText(JSON.stringify(arrayKey).slice(0, 120))).toBeInTheDocument();
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(await screen.findByText('null')).toBeInTheDocument();
  });

  it('renders parsed.key when meta.message is absent', async () => {
    vi.mocked(api.eventsHistory).mockResolvedValue({
      data: [{ receivedAt: '2026-01-01T10:00:00.000Z', data: JSON.stringify({ key: 'EVT_AP_Lost_Contact' }) }],
    });

    renderEvents();

    expect(await screen.findByText('EVT_AP_Lost_Contact')).toBeInTheDocument();
  });

  it('shows the empty-buffer message when there are no events', async () => {
    vi.mocked(api.eventsHistory).mockResolvedValue({ data: [] });

    renderEvents();

    expect(
      await screen.findByText(/Nenhum evento no buffer ainda/),
    ).toBeInTheDocument();
  });

  it('shows an error message when eventsHistory rejects', async () => {
    vi.mocked(api.eventsHistory).mockRejectedValue(new Error('Erro ao buscar eventos'));

    renderEvents();

    expect(await screen.findByText('Erro ao buscar eventos')).toBeInTheDocument();
  });
});
