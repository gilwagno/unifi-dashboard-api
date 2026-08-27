import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Clients } from './pages/Clients';
import { Devices } from './pages/Devices';
import { Events } from './pages/Events';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Security } from './pages/Security';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Overview />
          </RequireAuth>
        }
      />
      <Route
        path="/clients"
        element={
          <RequireAuth>
            <Clients />
          </RequireAuth>
        }
      />
      <Route
        path="/devices"
        element={
          <RequireAuth>
            <Devices />
          </RequireAuth>
        }
      />
      <Route
        path="/events"
        element={
          <RequireAuth>
            <Events />
          </RequireAuth>
        }
      />
      <Route
        path="/security"
        element={
          <RequireAuth>
            <Security />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
