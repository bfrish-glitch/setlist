import { useState } from 'react';
import { nugs } from '../sources/nugs';

export function NugsLogin({ onClose }: { onClose: (msg?: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await nugs.login(email.trim(), password);
      onClose('nugs.net connected');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <form className="sheet form-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="sheet-title">Sign in to nugs.net</div>
        <div className="form-body">
          <input
            type="email"
            autoComplete="username"
            placeholder="nugs email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <div className="form-error">{error}</div>}
          <button className="primary pill-btn" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="fine">
            Your password goes straight to nugs through Setlist’s server and is never saved. Setlist keeps only the
            login token nugs sends back, in this browser.
          </p>
        </div>
      </form>
    </div>
  );
}
