import { LayoutGrid, LogOut, Radio, Users, Wifi } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';

const NAV_ITEMS = [
  { to: '/', label: 'Visão geral', icon: LayoutGrid },
  { to: '/clients', label: 'Clientes', icon: Users },
  { to: '/devices', label: 'Dispositivos', icon: Wifi },
  { to: '/events', label: 'Eventos', icon: Radio },
];

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [siteName, setSiteName] = useState('Carregando...');

  useEffect(() => {
    api
      .listSites()
      .then((res) => setSiteName(res.data[0]?.name ?? 'Default'))
      .catch(() => setSiteName('Indisponível'));
  }, []);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-58 shrink-0 flex-col border-r border-slate-200 bg-white p-3.5">
        <div className="flex items-center gap-2.5 px-2.5 pb-5.5 pt-1.5">
          <Wifi className="h-5.5 w-5.5 text-accent" strokeWidth={2} />
          <span className="text-[15px] font-bold tracking-tight text-slate-900">UniFi Ops</span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] ${
                  isActive ? 'bg-accent/10 font-bold text-accent' : 'font-medium text-slate-600 hover:bg-slate-50'
                }`
              }
            >
              <Icon className="h-4.5 w-4.5 shrink-0" strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="grow" />

        <div className="flex flex-col gap-2.5 border-t border-slate-200 pt-3.5">
          <div className="flex items-center gap-2 px-2.5">
            <span className="h-1.75 w-1.75 shrink-0 rounded-full bg-[oklch(60%_0.15_150)]" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-semibold text-slate-700">Site: {siteName}</span>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-slate-500 hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" strokeWidth={2} />
            Sair
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 grow flex-col">
        <header className="flex h-15 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-7">
          <span className="text-[15px] font-bold text-slate-900">{title}</span>
          <div className="flex items-center gap-4.5">
            <div className="flex items-center gap-1.75 rounded-md border border-[oklch(88%_0.05_150)] bg-[oklch(96%_0.03_150_/_0.5)] px-2.75 py-1.25">
              <span className="h-1.5 w-1.5 rounded-full bg-[oklch(58%_0.16_150)]" />
              <span className="text-[11.5px] font-semibold text-[oklch(38%_0.1_150)]">API conectada</span>
            </div>
            <div className="flex h-7.5 w-7.5 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
              AD
            </div>
          </div>
        </header>

        <main className="grow overflow-auto p-7">{children}</main>
      </div>
    </div>
  );
}
