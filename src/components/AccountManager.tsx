import React, { useState, useMemo } from 'react';
import type { Account, Transaction } from '../types';
import { supabase } from '../supabaseClient';
import { usePreferences, CURRENCIES } from '../context/PreferencesContext';
import {
  Wallet,
  Plus,
  Trash2,
  AlertCircle,
  Loader2,
  RotateCcw,
  Banknote,
  Receipt,
  Search,
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  X,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import { CurrencyLogo } from './CurrencyLogo';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { accountSchema, type AccountFormData } from '../services/validationSchemas';
import { undoAccountTransaction, previewTransactionUndo, type UndoPreview } from '../services/transactionUndoService';

interface AccountManagerProps {
  userId: string;
  userEmail?: string;
  accounts: Account[];
  transactions?: Transaction[];
  onAccountUpdated: () => void;
  onTransactionsUpdated?: () => void;
}

export const AccountManager: React.FC<AccountManagerProps> = ({
  userId,
  userEmail,
  accounts,
  transactions = [],
  onAccountUpdated,
  onTransactionsUpdated,
}) => {
  const { preferences, formatCurrency, formatDate } = usePreferences();
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register: registerAccount,
    handleSubmit: handleAccountSubmit,
    formState: { errors: accountErrors },
    setValue: setAccountValue,
    reset: resetAccountForm,
  } = useForm<AccountFormData>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: '',
      balance: 0,
      currency: preferences.currency || 'USD',
    },
    mode: 'onTouched',
  });

  // Account Ledger & Undo Modal state
  const [selectedLedgerAccount, setSelectedLedgerAccount] = useState<Account | null>(null);
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [undoTargetTx, setUndoTargetTx] = useState<Transaction | null>(null);
  const [undoPreview, setUndoPreview] = useState<UndoPreview | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoFeedback, setUndoFeedback] = useState<string | null>(null);

  const onAccountInvalid = (errors: typeof accountErrors) => {
    const errorMsg =
      errors.name?.message ||
      errors.balance?.message ||
      errors.currency?.message ||
      'Please correct the account errors.';
    toast.error('Validation Alert', { description: errorMsg });
  };

  const onAddAccountSubmit = async (data: AccountFormData) => {
    setLoading(true);
    setError(null);

    try {
      const { error: insertError } = await supabase.from('accounts').insert({
        user_id: userId,
        name: data.name.trim(),
        balance: Number(data.balance) || 0,
        currency: data.currency,
      });

      if (insertError) throw insertError;

      resetAccountForm();
      setShowAddModal(false);
      toast.success('Account Created', {
        description: `Account "${data.name}" added successfully.`,
      });
      onAccountUpdated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add account';
      setError(msg);
      toast.error('Creation Failed', { description: msg });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this account? Associated transactions will be affected.')) {
      return;
    }

    try {
      const { error: delError } = await supabase.from('accounts').delete().eq('id', id);
      if (delError) throw delError;
      if (selectedLedgerAccount?.id === id) {
        setSelectedLedgerAccount(null);
      }
      toast.success('Account Deleted', { description: 'The account and associated ledgers were removed.' });
      onAccountUpdated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete account';
      toast.error('Delete Failed', { description: msg });
    }
  };

  const [isResetting, setIsResetting] = useState(false);

  const handleResetAccounts = async () => {
    if (
      !window.confirm(
        'Reset all financial accounts? This will set all account balances to 0.00 and restore a fresh default Checking Account.'
      )
    ) {
      return;
    }

    setIsResetting(true);
    try {
      // 1. Reset all current accounts to 0.00 balance
      await supabase.from('accounts').update({ balance: 0 }).eq('user_id', userId);

      // 2. Ensure at least one default Checking Account exists
      if (accounts.length === 0) {
        await supabase.from('accounts').insert({
          user_id: userId,
          name: 'Checking Account',
          balance: 0,
          currency: preferences.currency || 'USD',
        });
      }

      toast.success('Accounts Reset', { description: 'All account balances reset to 0.00.' });
      onAccountUpdated();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to reset accounts';
      toast.error('Reset Failed', { description: msg });
    } finally {
      setIsResetting(false);
    }
  };

  // Open transaction-wise undo modal for an account
  const handleOpenLedger = (acc: Account) => {
    setSelectedLedgerAccount(acc);
    setLedgerSearch('');
    setLedgerTypeFilter('all');
    setUndoFeedback(null);
    setUndoTargetTx(null);
    setUndoPreview(null);
  };

  // Filtered transactions for the selected account
  const accountTransactions = useMemo(() => {
    if (!selectedLedgerAccount) return [];
    return transactions.filter((t) => {
      if (t.account_id !== selectedLedgerAccount.id) return false;
      if (ledgerTypeFilter !== 'all' && t.type !== ledgerTypeFilter) return false;
      if (ledgerSearch.trim()) {
        const q = ledgerSearch.toLowerCase();
        const matchesDesc = t.description?.toLowerCase().includes(q);
        const matchesPrompt = t.raw_prompt?.toLowerCase().includes(q);
        if (!matchesDesc && !matchesPrompt) return false;
      }
      return true;
    });
  }, [selectedLedgerAccount, transactions, ledgerTypeFilter, ledgerSearch]);

  // Request undo confirmation
  const handleInitiateUndo = (tx: Transaction) => {
    if (!selectedLedgerAccount) return;
    const preview = previewTransactionUndo(tx, Number(selectedLedgerAccount.balance));
    setUndoTargetTx(tx);
    setUndoPreview(preview);
  };

  // Execute transaction undo
  const handleConfirmUndo = async () => {
    if (!undoTargetTx || !selectedLedgerAccount) return;

    setIsUndoing(true);
    try {
      const res = await undoAccountTransaction(undoTargetTx, selectedLedgerAccount, {
        userId,
        userEmail,
        isAdminAction: false,
      });

      setUndoFeedback(res.message);
      toast.success('Transaction Undone', { description: res.message });
      setUndoTargetTx(null);
      setUndoPreview(null);

      // Refresh parents
      onAccountUpdated();
      if (onTransactionsUpdated) {
        onTransactionsUpdated();
      }

      // Update selected ledger account local balance snapshot
      setSelectedLedgerAccount((prev) =>
        prev ? { ...prev, balance: res.newBalance } : null
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to undo transaction';
      toast.error('Undo Failed', { description: msg });
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white tracking-tight">Financial Accounts</h2>
            <p className="text-xs text-slate-400">Manage checking, savings, credit, and cash ledgers with transaction-wise undo</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleResetAccounts}
            disabled={isResetting}
            title="Reset all account balances to zero and restore default account"
            className="text-xs font-semibold px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/25 flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {isResetting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            <span>Reset Accounts</span>
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            className="text-xs font-semibold px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center gap-1.5 transition shadow-lg shadow-emerald-500/10 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Account</span>
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-xl">
          <Wallet className="w-10 h-10 text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-400 font-medium">No accounts found</p>
          <p className="text-xs text-slate-500 mt-1">Create an account to start tracking transactions</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="mt-4 text-xs font-semibold px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-slate-700 transition cursor-pointer"
          >
            + Add First Account
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((acc) => {
            const accTxs = transactions.filter((t) => t.account_id === acc.id);
            const isCash = /\b(cash|in-hand|wallet|petty)\b/i.test(acc.name);

            return (
              <div
                key={acc.id}
                className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition group shadow-md"
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className="font-semibold text-white text-sm">{acc.name}</h3>
                        {isCash && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                            <Banknote className="w-2.5 h-2.5" />
                            <span>In-Hand Cash</span>
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-slate-500 uppercase tracking-wider font-mono">
                        {acc.currency}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeleteAccount(acc.id)}
                      title="Delete account"
                      className="text-slate-600 hover:text-rose-400 transition p-1 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="mt-4">
                    <span className="text-xs text-slate-500 block">Current Balance</span>
                    <span className="text-xl font-bold text-white tracking-tight">
                      {new Intl.NumberFormat(undefined, {
                        style: 'currency',
                        currency: acc.currency || preferences.currency || 'USD',
                      }).format(Number(acc.balance))}
                    </span>
                  </div>
                </div>

                {/* Account Action: View Ledger & Undo Transactions */}
                <div className="mt-4 pt-3 border-t border-slate-850 flex items-center justify-between">
                  <span className="text-[11px] text-slate-400 font-medium">
                    {accTxs.length} {accTxs.length === 1 ? 'transaction' : 'transactions'}
                  </span>
                  <button
                    onClick={() => handleOpenLedger(acc)}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-1.5 transition cursor-pointer"
                    title="View all transactions on this account and undo transaction-wise"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-purple-400" />
                    <span>Undo Transactions</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ========================================================================= */}
      {/* ACCOUNT LEDGER & TRANSACTION-WISE UNDO MODAL */}
      {/* ========================================================================= */}
      {selectedLedgerAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="p-6 pb-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
                  <RotateCcw className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white">{selectedLedgerAccount.name}</h3>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                      {selectedLedgerAccount.currency}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Account Ledger &bull; Undo transactions transaction-wise to restore balances
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold block">Live Balance</span>
                  <span className="text-base font-bold text-emerald-400">
                    {formatCurrency(Number(selectedLedgerAccount.balance))}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedLedgerAccount(null)}
                  className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Notification / Feedback Banner */}
            {undoFeedback && (
              <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <span>{undoFeedback}</span>
                </div>
                <button
                  onClick={() => setUndoFeedback(null)}
                  className="text-slate-400 hover:text-white text-[11px]"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Active Undo Confirmation Banner */}
            {undoTargetTx && undoPreview && (
              <div className="mx-6 mt-4 p-4 rounded-2xl bg-purple-950/40 border border-purple-500/30 text-xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-purple-300 text-sm">
                    <RotateCcw className="w-4 h-4 text-purple-400" />
                    <span>Confirm Transaction Undo</span>
                  </div>
                  <button
                    onClick={() => {
                      setUndoTargetTx(null);
                      setUndoPreview(null);
                    }}
                    className="text-slate-400 hover:text-white text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 py-1">
                  <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase font-semibold">Transaction</span>
                    <span className="text-white font-semibold truncate block">{undoTargetTx.description}</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase font-semibold">Type</span>
                    <span className={`font-bold capitalize ${undoTargetTx.type === 'income' ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {undoTargetTx.type}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                    <span className="text-slate-500 block text-[10px] uppercase font-semibold">Current Balance</span>
                    <span className="text-slate-300 font-mono font-bold">
                      {formatCurrency(undoPreview.previousBalance)}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-950 border border-purple-500/40">
                    <span className="text-purple-400 block text-[10px] uppercase font-semibold">Projected Balance</span>
                    <span className="text-white font-mono font-bold">
                      {formatCurrency(undoPreview.projectedBalance)}
                    </span>
                  </div>
                </div>

                <p className="text-slate-300 text-[11px] leading-relaxed">
                  {undoPreview.actionDescription}. The transaction entry will be permanently removed from your ledger and related ERP references unlinked.
                </p>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    disabled={isUndoing}
                    onClick={() => {
                      setUndoTargetTx(null);
                      setUndoPreview(null);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold cursor-pointer text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isUndoing}
                    onClick={handleConfirmUndo}
                    className="px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold flex items-center gap-1.5 cursor-pointer shadow-lg shadow-purple-600/20 text-xs"
                  >
                    {isUndoing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="w-3.5 h-3.5" />
                    )}
                    <span>Execute Undo</span>
                  </button>
                </div>
              </div>
            )}

            {/* Filter and Search Bar */}
            <div className="p-6 py-4 flex flex-col sm:flex-row gap-3 border-b border-slate-850">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search this account's transactions..."
                  value={ledgerSearch}
                  onChange={(e) => setLedgerSearch(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>

              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs self-start">
                <button
                  onClick={() => setLedgerTypeFilter('all')}
                  className={`px-3 py-1 rounded-lg transition cursor-pointer ${
                    ledgerTypeFilter === 'all' ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400'
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setLedgerTypeFilter('income')}
                  className={`px-3 py-1 rounded-lg transition cursor-pointer ${
                    ledgerTypeFilter === 'income' ? 'bg-emerald-500/20 text-emerald-400 font-semibold' : 'text-slate-400'
                  }`}
                >
                  Income
                </button>
                <button
                  onClick={() => setLedgerTypeFilter('expense')}
                  className={`px-3 py-1 rounded-lg transition cursor-pointer ${
                    ledgerTypeFilter === 'expense' ? 'bg-rose-500/20 text-rose-400 font-semibold' : 'text-slate-400'
                  }`}
                >
                  Expense
                </button>
              </div>
            </div>

            {/* Transactions List */}
            <div className="p-6 pt-2 flex-1 overflow-y-auto space-y-2">
              {accountTransactions.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-2xl">
                  <Receipt className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-xs text-slate-400 font-medium">No transactions recorded for {selectedLedgerAccount.name}</p>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {transactions.some((t) => t.account_id === selectedLedgerAccount.id)
                      ? 'Try clearing your active search filter.'
                      : 'Transactions logged to this account will appear here with an instant Undo option.'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-800/80">
                  {accountTransactions.map((tx) => {
                    const isIncome = tx.type === 'income';
                    const categoryName = tx.categories?.name || 'Uncategorized';

                    return (
                      <div
                        key={tx.id}
                        className="py-3 flex items-center justify-between gap-3 hover:bg-slate-850/40 px-2 rounded-xl transition"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`p-2 rounded-xl flex-shrink-0 ${
                              isIncome
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                            }`}
                          >
                            {isIncome ? (
                              <ArrowDownLeft className="w-3.5 h-3.5" />
                            ) : (
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-white text-xs truncate">
                                {tx.description || 'Transaction'}
                              </span>
                              {tx.raw_prompt && (
                                <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  <Sparkles className="w-2 h-2" />
                                  AI
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">
                                {categoryName}
                              </span>
                              <span>&bull;</span>
                              <span className="flex items-center gap-1 text-slate-500">
                                <Calendar className="w-3 h-3" />
                                {formatDate(tx.transaction_date)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span
                            className={`font-bold text-xs sm:text-sm font-mono ${
                              isIncome ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isIncome ? '+' : '-'}
                            {formatCurrency(Number(tx.amount))}
                          </span>

                          <button
                            onClick={() => handleInitiateUndo(tx)}
                            title={`Undo this transaction and ${isIncome ? 'deduct' : 'refund'} ${formatCurrency(Number(tx.amount))} on ${selectedLedgerAccount.name}`}
                            className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/25 text-[11px] font-semibold flex items-center gap-1 transition cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3 text-rose-400" />
                            <span className="hidden sm:inline">Undo</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-950/40 flex items-center justify-between text-xs text-slate-400">
              <span className="text-[11px]">
                Showing {accountTransactions.length} transaction entries for {selectedLedgerAccount.name}
              </span>
              <button
                type="button"
                onClick={() => setSelectedLedgerAccount(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold transition cursor-pointer"
              >
                Close Ledger
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">Add New Account</h3>
            <p className="text-xs text-slate-400 mb-4">
              Enter account details and starting balance
            </p>

            {error && (
              <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleAccountSubmit(onAddAccountSubmit, onAccountInvalid)} className="space-y-4" noValidate>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                  Account Name
                </label>
                <input
                  type="text"
                  {...registerAccount('name')}
                  placeholder="e.g. Checking Account, Main Cash, Credit Card"
                  className={`w-full bg-slate-800 border ${
                    accountErrors.name
                      ? 'border-rose-500/80 focus:ring-rose-500/50'
                      : 'border-slate-700 focus:ring-emerald-500/50'
                  } rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:ring-2 transition`}
                />
                {accountErrors.name && (
                  <span className="text-xs text-rose-400 mt-1 flex items-center gap-1 font-medium">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {accountErrors.name.message}
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[10px] text-slate-500">Presets:</span>
                  {['Checking Account', 'Savings Account', 'In-Hand Cash (Physical Wallet)', 'Credit Card'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAccountValue('name', preset, { shouldValidate: true })}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Initial Balance
                  </label>
                  <CurrencyLogo variant="badge" />
                </div>
                <div className="relative">
                  <CurrencyLogo variant="input-prefix" />
                  <input
                    type="number"
                    step="0.01"
                    {...registerAccount('balance')}
                    className={`w-full bg-slate-800 border ${
                      accountErrors.balance
                        ? 'border-rose-500/80 focus:ring-rose-500/50'
                        : 'border-slate-700 focus:ring-emerald-500/50'
                    } rounded-xl pl-8 pr-3.5 py-2.5 text-sm text-white focus:outline-none focus:ring-2 transition`}
                  />
                </div>
                {accountErrors.balance && (
                  <span className="text-xs text-rose-400 mt-1 flex items-center gap-1 font-medium">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {accountErrors.balance.message}
                  </span>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                  Currency
                </label>
                <select
                  {...registerAccount('currency')}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} - {c.name}
                    </option>
                  ))}
                </select>
                {accountErrors.currency && (
                  <span className="text-xs text-rose-400 mt-1 flex items-center gap-1 font-medium">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {accountErrors.currency.message}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="text-xs px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="text-xs px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold flex items-center gap-2 transition disabled:opacity-50 cursor-pointer shadow-lg shadow-emerald-500/20"
                >
                  {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Save Account</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
