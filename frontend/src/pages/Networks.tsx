import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { api, ApiError, type FirewallZone, type UniFiNetwork, type WifiBroadcast } from '../lib/api';

// Zona usada como default no seletor de VLAN, quando existir — mesma zona
// usada como fallback no backend quando `zoneId` não é informado (ver
// src/routes/networks.routes.ts, DEFAULT_ZONE_NAME).
const DEFAULT_ZONE_NAME = 'Internal';

export function Networks() {
  const [wifis, setWifis] = useState<WifiBroadcast[]>([]);
  const [networks, setNetworks] = useState<UniFiNetwork[]>([]);
  const [zones, setZones] = useState<FirewallZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pendingWifiId, setPendingWifiId] = useState<string | null>(null);
  const [editingPasswordId, setEditingPasswordId] = useState<string | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');

  const [newWifiName, setNewWifiName] = useState('');
  const [newWifiPassword, setNewWifiPassword] = useState('');
  const [creatingWifi, setCreatingWifi] = useState(false);

  const [pendingNetworkId, setPendingNetworkId] = useState<string | null>(null);
  const [newNetworkName, setNewNetworkName] = useState('');
  const [newVlanId, setNewVlanId] = useState('');
  const [newHostIp, setNewHostIp] = useState('');
  const [newPrefixLength, setNewPrefixLength] = useState('24');
  const [newZoneId, setNewZoneId] = useState('');
  const [creatingNetwork, setCreatingNetwork] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([api.listWifi(), api.listNetworks(), api.listFirewallZones()])
      .then(([w, n, z]) => {
        setWifis(w.data);
        setNetworks(n.data);
        setZones(z.data);
        setNewZoneId((current) => {
          if (current) return current;
          const defaultZone = z.data.find((zone) => zone.name === DEFAULT_ZONE_NAME);
          return (defaultZone ?? z.data[0])?.id ?? '';
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar redes'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createWifi(e: React.FormEvent) {
    e.preventDefault();
    setCreatingWifi(true);
    setError(null);
    try {
      await api.createWifi({ name: newWifiName, passphrase: newWifiPassword });
      setNewWifiName('');
      setNewWifiPassword('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao criar rede Wi-Fi');
    } finally {
      setCreatingWifi(false);
    }
  }

  function startEditPassword(wifi: WifiBroadcast) {
    setEditingPasswordId(wifi.id);
    setPasswordDraft('');
  }

  async function submitPassword(wifi: WifiBroadcast) {
    if (passwordDraft.length < 8 || passwordDraft.length > 63) {
      setError('A senha deve ter entre 8 e 63 caracteres');
      return;
    }
    setPendingWifiId(wifi.id);
    setError(null);
    try {
      await api.setWifiPassword(wifi.id, passwordDraft);
      setEditingPasswordId(null);
      setPasswordDraft('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao trocar a senha');
    } finally {
      setPendingWifiId(null);
    }
  }

  async function toggleWifiEnabled(wifi: WifiBroadcast) {
    setPendingWifiId(wifi.id);
    setError(null);
    try {
      await api.setWifiEnabled(wifi.id, !wifi.enabled);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao habilitar/desabilitar a rede');
    } finally {
      setPendingWifiId(null);
    }
  }

  async function deleteWifi(wifi: WifiBroadcast) {
    if (!confirm(`Remover a rede Wi-Fi "${wifi.name}"? Todos os dispositivos conectados a ela perdem acesso.`)) return;
    setPendingWifiId(wifi.id);
    setError(null);
    try {
      await api.deleteWifi(wifi.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao remover a rede Wi-Fi');
    } finally {
      setPendingWifiId(null);
    }
  }

  async function createNetwork(e: React.FormEvent) {
    e.preventDefault();
    const vlanId = Number(newVlanId);
    const prefixLength = Number(newPrefixLength);
    if (!Number.isInteger(vlanId) || vlanId < 2 || vlanId > 4009) {
      setError('VLAN ID deve ser um número entre 2 e 4009');
      return;
    }
    setCreatingNetwork(true);
    setError(null);
    try {
      await api.createNetwork({
        name: newNetworkName,
        vlanId,
        hostIpAddress: newHostIp,
        prefixLength,
        zoneId: newZoneId || undefined,
      });
      setNewNetworkName('');
      setNewVlanId('');
      setNewHostIp('');
      setNewPrefixLength('24');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao criar VLAN');
    } finally {
      setCreatingNetwork(false);
    }
  }

  async function deleteNetwork(network: UniFiNetwork) {
    if (!confirm(`Remover a VLAN "${network.name}"? Dispositivos nessa rede perdem conectividade.`)) return;
    setPendingNetworkId(network.id);
    setError(null);
    try {
      await api.deleteNetwork(network.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao remover a VLAN');
    } finally {
      setPendingNetworkId(null);
    }
  }

  return (
    <Layout title="Redes">
      {error && (
        <div className="mb-4 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="mb-5.5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13.5px] font-bold text-slate-900">Redes Wi-Fi</span>
        </div>

        <form onSubmit={createWifi} className="mb-3 flex flex-wrap items-end gap-2.5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">Nome da rede</label>
            <input
              value={newWifiName}
              onChange={(e) => setNewWifiName(e.target.value)}
              required
              maxLength={32}
              className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              placeholder="ex: Escritório"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">Senha (8-63 caracteres)</label>
            <input
              value={newWifiPassword}
              onChange={(e) => setNewWifiPassword(e.target.value)}
              required
              minLength={8}
              maxLength={63}
              type="text"
              className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              placeholder="senha da rede"
            />
          </div>
          <button
            type="submit"
            disabled={creatingWifi}
            className="rounded-md bg-accent px-3.5 py-1.75 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            {creatingWifi ? 'Criando…' : 'Criar rede Wi-Fi'}
          </button>
        </form>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="grid grid-cols-[2fr_1fr_2.2fr_1.3fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <span>Nome</span>
            <span>Status</span>
            <span>Ações</span>
            <span className="text-right">Remover</span>
          </div>

          {loading && <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>}

          {!loading &&
            wifis.map((w) => (
              <div key={w.id} className="grid grid-cols-[2fr_1fr_2.2fr_1.3fr] items-center border-t border-slate-100 px-5 py-3">
                <span className="truncate text-[13px] font-semibold text-slate-800">{w.name}</span>
                <Badge tone={w.enabled ? 'success' : 'neutral'}>{w.enabled ? 'Ativa' : 'Desativada'}</Badge>

                {editingPasswordId === w.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      type="text"
                      value={passwordDraft}
                      onChange={(e) => setPasswordDraft(e.target.value)}
                      minLength={8}
                      maxLength={63}
                      placeholder="nova senha"
                      className="w-36 rounded-md border border-slate-300 px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => submitPassword(w)}
                      disabled={pendingWifiId === w.id}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                    >
                      Salvar
                    </button>
                    <button
                      onClick={() => setEditingPasswordId(null)}
                      className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-500"
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startEditPassword(w)}
                      disabled={pendingWifiId === w.id}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                    >
                      Trocar senha
                    </button>
                    <button
                      onClick={() => toggleWifiEnabled(w)}
                      disabled={pendingWifiId === w.id}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                    >
                      {pendingWifiId === w.id ? '...' : w.enabled ? 'Desabilitar' : 'Habilitar'}
                    </button>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    onClick={() => deleteWifi(w)}
                    disabled={pendingWifiId === w.id}
                    className="rounded-md border border-[oklch(87%_0.06_25)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(48%_0.16_25)] disabled:opacity-50"
                  >
                    Remover
                  </button>
                </div>
              </div>
            ))}

          {!loading && wifis.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-400">Nenhuma rede Wi-Fi encontrada.</div>
          )}
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13.5px] font-bold text-slate-900">VLANs</span>
        </div>

        <form onSubmit={createNetwork} className="mb-3 flex flex-wrap items-end gap-2.5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">Nome</label>
            <input
              value={newNetworkName}
              onChange={(e) => setNewNetworkName(e.target.value)}
              required
              maxLength={64}
              className="w-32 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              placeholder="ex: IoT"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">VLAN ID (2-4009)</label>
            <input
              value={newVlanId}
              onChange={(e) => setNewVlanId(e.target.value)}
              required
              type="number"
              min={2}
              max={4009}
              className="w-28 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              placeholder="10"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">IP do gateway</label>
            <input
              value={newHostIp}
              onChange={(e) => setNewHostIp(e.target.value)}
              required
              className="w-36 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[13px]"
              placeholder="10.30.0.1"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">Prefixo</label>
            <input
              value={newPrefixLength}
              onChange={(e) => setNewPrefixLength(e.target.value)}
              required
              type="number"
              min={1}
              max={32}
              className="w-20 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              placeholder="24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-slate-500">Zona de firewall</label>
            <select
              value={newZoneId}
              onChange={(e) => setNewZoneId(e.target.value)}
              className="w-36 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
            >
              {zones.length === 0 && <option value="">Carregando…</option>}
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={creatingNetwork}
            className="rounded-md bg-accent px-3.5 py-1.75 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            {creatingNetwork ? 'Criando…' : 'Criar VLAN'}
          </button>
        </form>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="grid grid-cols-[2fr_1fr_1.6fr_1.1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <span>Nome</span>
            <span>VLAN ID</span>
            <span>Sub-rede</span>
            <span className="text-right">Ação</span>
          </div>

          {loading && <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>}

          {!loading &&
            networks.map((n) => (
              <div key={n.id} className="grid grid-cols-[2fr_1fr_1.6fr_1.1fr] items-center border-t border-slate-100 px-5 py-3">
                <span className="truncate text-[13px] font-semibold text-slate-800">{n.name}</span>
                <span className="font-mono text-xs text-slate-500">{n.vlanId ?? '—'}</span>
                <span className="font-mono text-xs text-slate-500">
                  {n.ipv4Configuration?.hostIpAddress
                    ? `${n.ipv4Configuration.hostIpAddress}/${n.ipv4Configuration.prefixLength ?? '?'}`
                    : '—'}
                </span>
                <div className="flex justify-end">
                  <button
                    onClick={() => deleteNetwork(n)}
                    disabled={pendingNetworkId === n.id}
                    className="rounded-md border border-[oklch(87%_0.06_25)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(48%_0.16_25)] disabled:opacity-50"
                  >
                    Remover
                  </button>
                </div>
              </div>
            ))}

          {!loading && networks.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-400">Nenhuma VLAN encontrada.</div>
          )}
        </div>
      </div>
    </Layout>
  );
}
