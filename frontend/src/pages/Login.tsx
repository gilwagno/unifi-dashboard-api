import { Wifi, ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../lib/api';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível conectar ao servidor');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[oklch(97%_0.004_255)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-accent" />
      <div className="flex w-95 flex-col gap-7">
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-2.5">
            <Wifi className="h-7 w-7 text-accent" strokeWidth={2} />
            <span className="text-[19px] font-bold tracking-tight text-slate-900">UniFi Ops</span>
          </div>
          <span className="text-[13px] text-slate-500">Painel de controle de rede</span>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
        >
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-slate-900">Entrar</h1>
            <span className="text-[13px] text-slate-500">Use suas credenciais do dashboard</span>
          </div>

          <div className="flex flex-col gap-3.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-slate-600">Usuário</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-accent focus:bg-white focus:ring-1 focus:ring-accent"
                autoComplete="username"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-slate-600">Senha</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-accent focus:bg-white focus:ring-1 focus:ring-accent"
                autoComplete="current-password"
              />
            </label>
          </div>

          {error && <span className="text-[13px] font-medium text-[oklch(45%_0.18_25)]">{error}</span>}

          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.75 text-sm font-semibold text-white shadow-sm hover:bg-accent-hover disabled:opacity-60"
          >
            {loading ? 'Entrando...' : 'Entrar'}
            {!loading && <ArrowRight className="h-3.75 w-3.75" strokeWidth={2.5} />}
          </button>
        </form>

        <span className="text-center text-xs text-slate-400">Conectado via VPN local · TLS auto-assinado aceito</span>
      </div>
    </div>
  );
}
