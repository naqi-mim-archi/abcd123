import React, { useState } from 'react';
import { X, Mail, Lock, User as UserIcon, Loader2, LogIn } from 'lucide-react';
import { signInWithEmail, signUpWithEmail, signInWithGoogle, sendPasswordReset, getFirebaseAuthErrorMessage } from '../services/firebase/authService';
import { isFirebaseConfigured } from '../services/firebase/firebaseConfig';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const GoogleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
  </svg>
);

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const inputClass = 'w-full pl-10 pr-4 py-3 rounded-2xl border border-slate-200 bg-slate-50 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 transition-colors';

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      if (mode === 'signup') {
        await signUpWithEmail(email, password, displayName || undefined);
      } else {
        await signInWithEmail(email, password);
      }
      onClose();
    } catch (err: any) {
      setError(getFirebaseAuthErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Without this, anyone who forgets an email/password is locked out permanently — there
  // was no recovery path at all before.
  const handleForgotPassword = async () => {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError('Enter your email address first, then press Forgot password.');
      return;
    }
    setIsSubmitting(true);
    try {
      await sendPasswordReset(email.trim());
      setNotice('If that address has an account, a reset link is on its way.');
    } catch (err: any) {
      setError(getFirebaseAuthErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      const user = await signInWithGoogle();
      // `null` means the popup was blocked and the page is navigating to Google's redirect
      // flow — leave the modal in its loading state rather than flashing it closed.
      if (!user) return;
      setIsSubmitting(false);
      onClose();
    } catch (err: any) {
      setError(getFirebaseAuthErrorMessage(err));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 space-y-6 animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-900 rounded-xl text-white shadow-lg shadow-slate-300">
              <LogIn className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-black text-slate-900 leading-tight">
              {mode === 'signin' ? 'Sign In' : 'Create Account'}
            </h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-800 transition-colors cursor-pointer">
            <X size={20} />
          </button>
        </div>

        {!isFirebaseConfigured ? (
          <div className="bg-amber-50 border border-amber-100 text-amber-800 text-xs font-medium p-4 rounded-2xl leading-relaxed">
            Firebase isn't configured yet on this deployment. Add the VITE_FIREBASE_* environment variables to enable sign-in.
          </div>
        ) : (
          <>
            <button
              onClick={handleGoogleSignIn}
              disabled={isSubmitting}
              className="w-full py-3 bg-white border border-slate-200 rounded-2xl font-bold text-sm text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center gap-3 disabled:opacity-50"
            >
              <GoogleIcon className="w-5 h-5" />
              Continue with Google
            </button>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-100" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">or</span>
              <div className="flex-1 h-px bg-slate-100" />
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-3">
              {mode === 'signup' && (
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder="Full name"
                    className={inputClass}
                  />
                </div>
              )}
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Email address"
                  className={inputClass}
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  className={inputClass}
                />
              </div>

              {mode === 'signin' && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={isSubmitting}
                    className="text-xs font-bold text-slate-500 hover:text-slate-900 hover:underline disabled:opacity-50"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {notice && (
                <p className="text-xs font-medium text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">{notice}</p>
              )}

              {error && (
                <p className="text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {mode === 'signin' ? 'Sign In' : 'Create Account'}
              </button>
            </form>

            <p className="text-center text-xs font-medium text-slate-500">
              {mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}{' '}
              <button
                onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setNotice(null); }}
                className="text-slate-900 font-bold hover:underline"
              >
                {mode === 'signin' ? 'Sign up' : 'Sign in'}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
};
