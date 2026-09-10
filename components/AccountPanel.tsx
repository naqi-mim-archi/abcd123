import React, { useState } from 'react';
import { X, UserCircle, Loader2, Mail, Check, Download, Trash2, KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import { sendPasswordReset, resendEmailVerification, updateDisplayName, getFirebaseAuthErrorMessage } from '../services/firebase/authService';
import { buildAccountExport, downloadAccountExport, deleteAccount, reauthenticate, usesPasswordSignIn } from '../services/firebase/accountService';

interface AccountPanelProps {
  isOpen: boolean;
  onClose: () => void;
  user: FirebaseUser;
  /**
   * Present only once entitlements are being written server-side. Until subscription
   * packages exist, nothing writes this and the plan row stays hidden.
   */
  planName?: string | null;
}

const DELETE_CONFIRMATION = 'delete my account';

export const AccountPanel: React.FC<AccountPanelProps> = ({ isOpen, onClose, user, planName }) => {
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [isSavingName, setIsSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [reauthPassword, setReauthPassword] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);

  if (!isOpen) return null;

  const inputClass = 'w-full px-4 py-3 rounded-2xl border border-slate-200 bg-slate-50 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 transition-colors';
  const secondaryButtonClass = 'w-full py-3 bg-white border border-slate-200 rounded-2xl font-bold text-sm text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center gap-2 disabled:opacity-50';
  const hasPassword = usesPasswordSignIn(user);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err: any) {
      setError(getFirebaseAuthErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveName = async () => {
    setIsSavingName(true);
    setError(null);
    try {
      await updateDisplayName(displayName);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch (err: any) {
      setError(getFirebaseAuthErrorMessage(err));
    } finally {
      setIsSavingName(false);
    }
  };

  const handleExport = () => run('export', async () => {
    const data = await buildAccountExport();
    downloadAccountExport(data);
    setNotice(`Exported ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}.`);
  });

  const handleDelete = () => run('delete', async () => {
    try {
      await deleteAccount(message => setNotice(message));
    } catch (err: any) {
      // Firebase refuses to delete an account whose sign-in is more than a few minutes
      // old. Ask for credentials, then let the user press Delete again.
      if (String(err?.code) === 'auth/requires-recent-login') {
        setNeedsReauth(true);
        throw err;
      }
      throw err;
    }
    onClose();
  });

  const handleReauth = () => run('reauth', async () => {
    await reauthenticate(hasPassword ? reauthPassword : undefined);
    setReauthPassword('');
    setNeedsReauth(false);
    setNotice('Confirmed. Press Delete Account again to finish.');
  });

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-900 rounded-xl text-white shadow-lg shadow-slate-300">
              <UserCircle className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-black text-slate-900 leading-tight">Account</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-800 transition-colors cursor-pointer">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Mail className="w-4 h-4 text-slate-400" />
              <span className="truncate">{user.email || 'No email address'}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-medium">
              {user.emailVerified ? (
                <span className="flex items-center gap-1.5 text-emerald-600"><ShieldCheck className="w-3.5 h-3.5" />Email verified</span>
              ) : (
                <>
                  <span className="flex items-center gap-1.5 text-amber-600"><ShieldAlert className="w-3.5 h-3.5" />Email not verified</span>
                  <button
                    onClick={() => run('verify', async () => {
                      await resendEmailVerification();
                      setNotice('Verification email sent.');
                    })}
                    disabled={busy === 'verify'}
                    className="text-slate-900 font-bold hover:underline disabled:opacity-50"
                  >
                    Resend
                  </button>
                </>
              )}
            </div>
            {planName && (
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest pt-1">Plan · {planName}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Display name</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Your name"
              className={inputClass}
            />
            <button
              onClick={handleSaveName}
              disabled={isSavingName || displayName === (user.displayName || '')}
              className={secondaryButtonClass}
            >
              {isSavingName ? <Loader2 className="w-4 h-4 animate-spin" /> : nameSaved ? <Check className="w-4 h-4" /> : null}
              {nameSaved ? 'Saved' : 'Save name'}
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Your data</label>
            {hasPassword && (
              <button
                onClick={() => run('reset', async () => {
                  if (!user.email) throw { code: 'auth/missing-email' };
                  await sendPasswordReset(user.email);
                  setNotice('Password reset email sent.');
                })}
                disabled={busy === 'reset'}
                className={secondaryButtonClass}
              >
                {busy === 'reset' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Change password
              </button>
            )}
            <button onClick={handleExport} disabled={busy === 'export'} className={secondaryButtonClass}>
              {busy === 'export' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Export my data
            </button>
          </div>

          {notice && (
            <p className="text-xs font-medium text-slate-600 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">{notice}</p>
          )}
          {error && (
            <p className="text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>
          )}

          <div className="space-y-2 pt-2 border-t border-slate-100">
            {!isDeleteOpen ? (
              <button
                onClick={() => setIsDeleteOpen(true)}
                className="w-full py-3 bg-white border border-red-100 rounded-2xl font-bold text-sm text-red-600 hover:bg-red-50 transition-all flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Delete account
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs font-medium text-slate-600 leading-relaxed">
                  This permanently deletes your account and every saved project. It cannot be undone.
                  Type <span className="font-bold text-slate-900">{DELETE_CONFIRMATION}</span> to confirm.
                </p>
                <input
                  type="text"
                  value={deleteConfirmation}
                  onChange={e => setDeleteConfirmation(e.target.value)}
                  placeholder={DELETE_CONFIRMATION}
                  className={inputClass}
                />
                {needsReauth && (
                  hasPassword ? (
                    <input
                      type="password"
                      value={reauthPassword}
                      onChange={e => setReauthPassword(e.target.value)}
                      placeholder="Confirm your password"
                      className={inputClass}
                    />
                  ) : null
                )}
                {needsReauth && (
                  <button onClick={handleReauth} disabled={busy === 'reauth'} className={secondaryButtonClass}>
                    {busy === 'reauth' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                    {hasPassword ? 'Confirm password' : 'Confirm with Google'}
                  </button>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setIsDeleteOpen(false); setDeleteConfirmation(''); setNeedsReauth(false); }}
                    className="flex-1 py-3 bg-white border border-slate-200 rounded-2xl font-bold text-sm text-slate-700 hover:bg-slate-50 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleteConfirmation.trim().toLowerCase() !== DELETE_CONFIRMATION || busy === 'delete'}
                    className="flex-1 py-3 bg-red-600 text-white rounded-2xl font-bold text-sm hover:bg-red-700 transition-all flex items-center justify-center gap-2 disabled:opacity-40"
                  >
                    {busy === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    Delete Account
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
