import React, { useEffect, useState } from 'react';
import { ShieldCheck, Lock, ArrowRight, AlertCircle } from 'lucide-react';
import { apiFetch, setAuthToken } from '../lib/api';
import type { DemoAccount, UserContext } from '../types';

interface LoginViewProps {
  onSuccess: (user: UserContext, dialect: string) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onSuccess }) => {
  const [email, setEmail] = useState('doc@clinic360.local');
  const [password, setPassword] = useState('Clinic360!');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [twoFaChallenge, setTwoFaChallenge] = useState<{
    challengeId: string;
    maskedEmail: string;
    devVerificationCode?: string;
  } | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchAccounts = (attempt = 0) => {
      apiFetch<{ accounts?: DemoAccount[] }>('/api/auth/demo-accounts')
        .then((res) => {
          if (!cancelled) {
            setAccounts(Array.isArray(res?.accounts) ? res.accounts : []);
          }
        })
        .catch(() => {
          if (!cancelled && attempt < 2) {
            setTimeout(() => fetchAccounts(attempt + 1), 1000);
          }
        });
    };
    fetchAccounts();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(e?: React.FormEvent, overrideEmail?: string) {
    if (e) e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const targetEmail = overrideEmail ?? email;
      const res = await apiFetch<{
        token?: string;
        user?: UserContext;
        dialect?: string;
        requires2fa?: boolean;
        challengeId?: string;
        maskedEmail?: string;
        devVerificationCode?: string;
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: targetEmail, password }),
      });

      if (res.requires2fa && res.challengeId) {
        setTwoFaChallenge({
          challengeId: res.challengeId,
          maskedEmail: res.maskedEmail || targetEmail,
          devVerificationCode: res.devVerificationCode,
        });
        setTwoFaCode(res.devVerificationCode || '');
        return;
      }

      if (res.token && res.user) {
        setAuthToken(res.token);
        onSuccess(res.user, res.dialect || 'sqlite');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify2fa(e: React.FormEvent) {
    e.preventDefault();
    if (!twoFaChallenge) return;
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: UserContext; dialect: string }>('/api/auth/verify-2fa', {
        method: 'POST',
        body: JSON.stringify({ challengeId: twoFaChallenge.challengeId, code: twoFaCode }),
      });
      setAuthToken(res.token);
      onSuccess(res.user, res.dialect);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-lg overflow-hidden">
        {/* Left: Sign-in Form */}
        <div className="lg:col-span-5 p-8 sm:p-10 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-200">
          <div>
            <div className="flex items-center gap-2.5 mb-8">
              <div className="w-8 h-8 rounded-md bg-teal-700 text-white flex items-center justify-center font-display font-bold text-sm">
                C3
              </div>
              <span className="font-display font-bold text-lg tracking-tight text-slate-900">
                Clinic360
              </span>
            </div>

            <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight mb-2">
              {twoFaChallenge ? 'Two-Factor Verification' : 'Staff Sign In'}
            </h1>
            <p className="text-sm text-slate-600 mb-6 leading-relaxed">
              {twoFaChallenge
                ? `Enter the 6-digit authenticator code dispatched for ${twoFaChallenge.maskedEmail} (enforced for ADM, ACC, and MGR accounts).`
                : 'Role-based clinical operations, patient records, appointment scheduling, and audited billing.'}
            </p>

            {error && (
              <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2.5 text-xs text-red-800">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                <span>{error}</span>
              </div>
            )}

            {twoFaChallenge ? (
              <form onSubmit={handleVerify2fa} className="space-y-4">
                {twoFaChallenge.devVerificationCode && (
                  <div className="p-3 bg-teal-50 border border-teal-200 rounded-md text-xs text-teal-900">
                    Demo Authenticator Code:{' '}
                    <span className="font-mono font-bold tracking-widest">{twoFaChallenge.devVerificationCode}</span>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    6-Digit Verification Code
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={twoFaCode}
                    onChange={(e) => setTwoFaCode(e.target.value)}
                    placeholder="000000"
                    className="w-full px-3 py-2 text-base tracking-[0.35em] text-center border border-slate-300 rounded-md bg-white text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors disabled:opacity-60 whitespace-nowrap"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>{loading ? 'Verifying Code...' : 'Verify & Open Workspace'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTwoFaChallenge(null);
                    setTwoFaCode('');
                    setError(null);
                  }}
                  className="w-full px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md"
                >
                  Back to Sign In
                </button>
              </form>
            ) : (
              <form onSubmit={(e) => handleLogin(e)} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Staff Email
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                    placeholder="name@clinic360.local"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700 font-mono"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors disabled:opacity-60 whitespace-nowrap"
                >
                  <Lock className="w-4 h-4" />
                  <span>{loading ? 'Authenticating...' : 'Sign In to Workspace'}</span>
                </button>
              </form>
            )}
          </div>

          <div className="mt-8 pt-6 border-t border-slate-200 flex items-center gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
            <span>Every clinical read, payment, and role check is written to the SHA-256 audit chain.</span>
          </div>
        </div>

        {/* Right: Role Switcher Directory */}
        <div className="lg:col-span-7 p-8 sm:p-10 bg-slate-50/70">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-sm font-semibold text-slate-900">
              Staff Role Presets (Demo Password: <span className="font-mono text-teal-800">Clinic360!</span>)
            </h2>
            <span className="text-xs text-slate-500">Select a role to test RBAC</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {(accounts || []).length === 0 ? (
              <div className="sm:col-span-2 p-6 bg-white border border-slate-200 rounded-md text-xs text-slate-500 text-center">
                Loading staff role presets, or sign in manually using the form on the left.
              </div>
            ) : (
              (accounts || []).map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setEmail(acc.email);
                    setPassword('Clinic360!');
                    handleLogin(undefined, acc.email);
                  }}
                  className="group text-left p-3 bg-white border border-slate-200 hover:border-teal-600 rounded-md transition-colors flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 truncate">
                      {acc.full_name}
                    </div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">
                      <span className="font-mono font-medium text-teal-800">{acc.role_code}</span>
                      <span className="mx-1.5">·</span>
                      <span>{acc.role_name}</span>
                    </div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-700 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
