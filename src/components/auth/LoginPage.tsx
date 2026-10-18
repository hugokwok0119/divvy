import { useState } from 'react';
import { signIn } from '../../lib/auth-client';

export function LoginPage({ onTryDemo }: { onTryDemo?: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const tryDemo = async () => {
    setLoading(true);
    setFailed(false);
    try { await onTryDemo!(); } catch { setFailed(true); } finally { setLoading(false); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-sm w-full bg-white rounded-xl shadow p-8 text-center">
        <h1 className="text-heading1 font-semibold text-slate-900">Divvy</h1>
        <p className="mt-2 text-sm text-slate-600">Sign in to see your shared expenses.</p>
        <button
          onClick={() => signIn.social({ provider: 'google', callbackURL: '/' })}
          className="mt-6 w-full rounded-lg border border-slate-300 py-2.5 text-sm font-medium hover:bg-slate-50"
        >
          Continue with Google
        </button>
        <p className="mt-4 text-xs text-slate-400">
          Divvy is private. Only invited addresses can sign in.
        </p>
        {onTryDemo && (
          <>
            <div className="mt-6 flex items-center gap-3 text-body2 text-slate-400" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
            </div>
            <button
              type="button"
              onClick={() => void tryDemo()}
              disabled={loading}
              aria-busy={loading}
              className="mt-6 w-full rounded-lg bg-slate-900 py-2.5 text-body1 font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {loading ? 'Loading demo…' : 'Try the demo'}
            </button>
            {failed && <p role="alert" className="mt-2 text-body2 text-red-600">The demo could not load. Try again.</p>}
            <p className="mt-2 text-body2 text-slate-500">No sign-in. Fictional household. Nothing you do is saved or sent.</p>
          </>
        )}
      </div>
    </div>
  );
}
