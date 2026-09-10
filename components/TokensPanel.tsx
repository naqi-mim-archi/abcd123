import React, { useCallback, useEffect, useState } from 'react';
import { X, Coins, Loader2, Check, HardDrive, ArrowUpRight, Sparkles, ScanLine, Image as ImageIcon } from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import { ACTION_PRICES, TOKEN_PACKS, formatTokens, formatBytes, type TokenPack } from '../services/billing/pricing';
import {
  fetchAccountSummary,
  listRecentLedgerEntries,
  startCheckout,
  type AccountBalance,
  type LedgerEntry,
} from '../services/billing/balanceClient';

interface TokensPanelProps {
  isOpen: boolean;
  onClose: () => void;
  user: FirebaseUser;
  balance: AccountBalance;
  /** Set when the panel was opened because an action was refused for want of tokens. */
  shortfall?: { required: number; balance: number } | null;
}

const ACTION_ROWS = [
  { icon: Sparkles, label: 'Generate a floorplan', sublabel: 'Described in words, then digitised', cost: ACTION_PRICES.generateAndConvert },
  { icon: ScanLine, label: 'Convert a floorplan', sublabel: 'Digitise one you already have', cost: ACTION_PRICES.convertOnly },
  { icon: ImageIcon, label: 'AI render', sublabel: 'One rendered image', cost: ACTION_PRICES.render },
];

export const TokensPanel: React.FC<TokensPanelProps> = ({ isOpen, onClose, user, balance, shortfall }) => {
  const [summaryStorage, setSummaryStorage] = useState<{ usedBytes: number; quotaBytes: number; metered: boolean } | null>(null);
  // The server reads the ledger with admin credentials, so it can answer even when the
  // browser's own live read is refused. Used in preference to the subscription whenever
  // that subscription has not produced a trustworthy number.
  const [serverBalance, setServerBalance] = useState<number | null>(null);
  const [paymentsEnabled, setPaymentsEnabled] = useState(true);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [buyingPackId, setBuyingPackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Creates the entitlement for a brand-new account and recomputes storage from the
      // bucket — neither of which the browser can do on its own.
      const summary = await fetchAccountSummary();
      setSummaryStorage(summary.storage);
      setPaymentsEnabled(summary.paymentsEnabled);
      setServerBalance(summary.tokenBalance);
    } catch (err: any) {
      setError(err?.message || 'Could not load your token balance.');
    } finally {
      setIsLoading(false);
    }

    // History is secondary: the balance, prices and storage above are what the panel is
    // for. A ledger read that fails (rules not deployed yet, say) shows an empty list
    // rather than an error banner over a panel that is otherwise working.
    try {
      setEntries(await listRecentLedgerEntries(user.uid));
    } catch (err) {
      console.warn('Could not load recent token activity:', err);
      setEntries([]);
    }
  }, [user.uid]);

  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const handleBuy = async (pack: TokenPack) => {
    setBuyingPackId(pack.id);
    setError(null);
    try {
      window.location.href = await startCheckout(pack.id, user.email);
    } catch (err: any) {
      setError(err?.message || 'Could not start checkout.');
      setBuyingPackId(null);
    }
  };

  const storage = summaryStorage || { usedBytes: balance.storageBytesUsed, quotaBytes: balance.storageQuotaBytes, metered: false };
  const storagePercent = storage.quotaBytes > 0 ? Math.min(100, (storage.usedBytes / storage.quotaBytes) * 100) : 0;

  const liveBalanceTrusted = balance.status === 'ok';
  const shownBalance = liveBalanceTrusted ? balance.tokenBalance : serverBalance;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-900 rounded-xl text-white shadow-lg shadow-slate-300">
              <Coins className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-black text-slate-900 leading-tight">Tokens</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 hover:text-slate-800 transition-colors cursor-pointer">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 border-b border-slate-100 bg-slate-50/50">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Balance</p>
          <p className="text-3xl font-black text-slate-900 mt-1">
            {shownBalance === null ? '—' : shownBalance.toLocaleString()}
          </p>
          {balance.status === 'unreadable' && (
            <p className="mt-3 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 leading-relaxed">
              Your balance can't update live yet — the Firestore security rules haven't been
              deployed. The figure above comes from the server and is correct; it just won't
              refresh on its own until <span className="font-bold">firebase deploy --only firestore:rules</span> has run.
            </p>
          )}
          {shortfall && (
            <p className="mt-3 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 leading-relaxed">
              That action needs {formatTokens(shortfall.required)} and you have {shortfall.balance.toLocaleString()}. Top up below to carry on.
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-3 border-b border-slate-100">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">What things cost</p>
            {ACTION_ROWS.map(row => {
              const Icon = row.icon;
              return (
                <div key={row.label} className="flex items-center gap-3">
                  <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-slate-800 truncate">{row.label}</p>
                    <p className="text-[10px] font-medium text-slate-400">{row.sublabel}</p>
                  </div>
                  <span className="text-sm font-black text-slate-900 whitespace-nowrap">{row.cost}</span>
                </div>
              );
            })}
            <p className="text-[11px] font-medium text-slate-400 pt-1">The 2D and 3D canvas are free to use.</p>
          </div>

          <div className="p-6 space-y-2 border-b border-slate-100">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Top up</p>
            {TOKEN_PACKS.map(pack => (
              <button
                key={pack.id}
                onClick={() => handleBuy(pack)}
                disabled={!paymentsEnabled || buyingPackId !== null}
                className="w-full flex items-center gap-3 p-3 rounded-2xl border border-slate-100 hover:bg-slate-50 transition-colors disabled:opacity-50 text-left"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-800">{pack.tokens.toLocaleString()} tokens</p>
                  <p className="text-[10px] font-medium text-slate-400">
                    ${(pack.priceUsd / pack.tokens * 100).toFixed(2)} per 100 tokens
                  </p>
                </div>
                <span className="text-sm font-black text-slate-900">${pack.priceUsd}</span>
                {buyingPackId === pack.id ? (
                  <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                ) : (
                  <ArrowUpRight className="w-4 h-4 text-slate-300" />
                )}
              </button>
            ))}
            {!paymentsEnabled && (
              <p className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                Card payments aren't switched on for this deployment yet.
              </p>
            )}
          </div>

          <div className="p-6 space-y-2 border-b border-slate-100">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                <HardDrive className="w-3 h-3" /> Storage
              </p>
              <p className="text-[11px] font-bold text-slate-500">
                {formatBytes(storage.usedBytes)} of {formatBytes(storage.quotaBytes)}
              </p>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${storagePercent >= 100 ? 'bg-red-500' : 'bg-slate-900'}`}
                style={{ width: `${storagePercent}%` }}
              />
            </div>
            {!storage.metered && (
              <p className="text-[11px] font-medium text-slate-400">Storage metering isn't switched on for this deployment.</p>
            )}
          </div>

          <div className="p-6 space-y-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Recent activity</p>
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : entries.length === 0 ? (
              <p className="text-xs font-medium text-slate-400 py-4">Nothing yet.</p>
            ) : (
              entries.map(entry => (
                <div key={entry.id} className="flex items-center gap-3 py-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-700 truncate">{entry.detail || entry.reason}</p>
                    <p className="text-[10px] font-medium text-slate-400">
                      {entry.createdAt ? entry.createdAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                    </p>
                  </div>
                  <span className={`text-xs font-black whitespace-nowrap ${entry.amount >= 0 ? 'text-emerald-600' : 'text-slate-500'}`}>
                    {entry.amount >= 0 ? '+' : ''}{entry.amount}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {error && (
          <p className="mx-6 mb-4 text-xs font-medium text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">{error}</p>
        )}
      </div>
    </div>
  );
};
