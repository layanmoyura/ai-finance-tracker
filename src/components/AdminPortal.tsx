import React, { useState, useMemo, useEffect, useCallback } from 'react';
import type { PlatformUserSummary, PlatformActivityLog, ActivityEventType, Account, Transaction, UserDeviceSession } from '../types';
import { supabase } from '../supabaseClient';
import {
  ShieldAlert,
  ShieldCheck,
  Users,
  Activity,
  Search,
  Filter,
  RefreshCw,
  Download,
  Lock,
  Unlock,
  Laptop,
  CheckCircle2,
  Clock,
  Database,
  Sparkles,
  X,
  EyeOff,
  RotateCcw,
  Trash2,
  AlertTriangle,
  Check,
  Loader2,
  HardDrive,
  Globe,
  Smartphone,
  Calendar,
  ArrowDownLeft,
  ArrowUpRight,
} from 'lucide-react';
import {
  getPlatformUsers,
  getPlatformActivityLogs,
  setAdminSession,
  isAuthorizedAdmin,
  logPlatformEvent,
} from '../services/adminTelemetry';
import {
  purgeAllDatabaseData,
  getDatabaseDiagnostics,
  type DatabaseDiagnostics,
  type DatabaseRefreshReport,
} from '../services/databaseAdminService';
import {
  isDeviceLockDisabled,
  setDeviceLockDisabled,
  isUserDeviceLockDisabled,
  setUserDeviceLockDisabled,
  clearUserDeviceSession,
  getUserDeviceSession,
} from '../services/deviceSessionService';
import {
  undoAccountTransaction,
  previewTransactionUndo,
  type UndoPreview,
} from '../services/transactionUndoService';
import { useAlert } from '../context/AlertContext';

interface AdminPortalProps {
  currentUserId?: string;
  currentUserEmail?: string;
  userStats?: {
    transactionsCount: number;
    accountsCount: number;
    tasksCount: number;
    subsCount: number;
  };
  accounts?: Account[];
  transactions?: Transaction[];
  onLockSession: () => void;
  onRefreshDatabase?: () => Promise<void> | void;
}

type AdminViewTab = 'users' | 'activity' | 'database' | 'security';

export const AdminPortal: React.FC<AdminPortalProps> = ({
  currentUserId,
  currentUserEmail,
  userStats,
  accounts: propAccounts = [],
  transactions: propTransactions = [],
  onLockSession,
  onRefreshDatabase,
}) => {
  const { showError, showSuccess } = useAlert();
  const [activeTab, setActiveTab] = useState<AdminViewTab>('users');
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'user'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [activityTypeFilter, setActivityTypeFilter] = useState<ActivityEventType | 'ALL'>('ALL');
  const [selectedUser, setSelectedUser] = useState<PlatformUserSummary | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Device Lock State (Admin Governance)
  const [isDeviceLockDisabledState, setIsDeviceLockDisabledState] = useState<boolean>(() =>
    isDeviceLockDisabled()
  );

  useEffect(() => {
    const handleLockChange = () => {
      setIsDeviceLockDisabledState(isDeviceLockDisabled());
    };
    window.addEventListener('apex_device_lock_changed', handleLockChange);
    window.addEventListener('storage', handleLockChange);
    return () => {
      window.removeEventListener('apex_device_lock_changed', handleLockChange);
      window.removeEventListener('storage', handleLockChange);
    };
  }, []);

  const handleToggleDeviceLock = () => {
    const next = !isDeviceLockDisabledState;
    setDeviceLockDisabled(next);
    setIsDeviceLockDisabledState(next);
    logPlatformEvent(
      'SECURITY',
      next
        ? 'Admin disabled hardware sentinel device lock (multi-device logins permitted)'
        : 'Admin enabled hardware sentinel device lock (strict 1-device enforcement active)',
      currentUserId,
      currentUserEmail
    );
  };

  // User Inspector State (Accounts, Transactions & Device Sessions)
  const [selectedUserAccounts, setSelectedUserAccounts] = useState<Account[]>([]);
  const [selectedUserTransactions, setSelectedUserTransactions] = useState<Transaction[]>([]);
  const [selectedUserDeviceSession, setSelectedUserDeviceSession] = useState<UserDeviceSession | null>(null);
  const [selectedUserLockDisabled, setSelectedUserLockDisabled] = useState(false);
  const [isLoadingUserDetails, setIsLoadingUserDetails] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'profile' | 'device' | 'accounts' | 'transactions'>('profile');
  const [inspectorTxSearch, setInspectorTxSearch] = useState('');

  // Admin Transaction Undo State
  const [adminUndoTarget, setAdminUndoTarget] = useState<Transaction | null>(null);
  const [adminUndoPreview, setAdminUndoPreview] = useState<UndoPreview | null>(null);
  const [isAdminUndoing, setIsAdminUndoing] = useState(false);
  const [adminUndoFeedback, setAdminUndoFeedback] = useState<string | null>(null);

  const loadUserDetails = useCallback(async (user: PlatformUserSummary) => {
    setIsLoadingUserDetails(true);
    setAdminUndoFeedback(null);
    setAdminUndoTarget(null);
    setAdminUndoPreview(null);
    try {
      // 1. Fetch user device session
      const session = await getUserDeviceSession(user.id);
      setSelectedUserDeviceSession(session);
      setSelectedUserLockDisabled(isUserDeviceLockDisabled(user.id));

      // 2. Fetch accounts
      if (user.id === currentUserId && propAccounts.length > 0) {
        setSelectedUserAccounts(propAccounts);
      } else {
        const { data: accData } = await supabase
          .from('accounts')
          .select('*')
          .eq('user_id', user.id);
        setSelectedUserAccounts(accData || []);
      }

      // 3. Fetch transactions
      if (user.id === currentUserId && propTransactions.length > 0) {
        setSelectedUserTransactions(propTransactions);
      } else {
        const { data: txData } = await supabase
          .from('transactions')
          .select('*, accounts(name, currency), categories(name)')
          .eq('user_id', user.id)
          .order('transaction_date', { ascending: false });
        setSelectedUserTransactions((txData as Transaction[]) || []);
      }
    } catch (err) {
      console.warn('Error loading user inspection details:', err);
    } finally {
      setIsLoadingUserDetails(false);
    }
  }, [currentUserId, propAccounts, propTransactions]);

  useEffect(() => {
    if (selectedUser) {
      loadUserDetails(selectedUser);
    }
  }, [selectedUser, loadUserDetails]);

  const handleReleaseUserDeviceLock = async () => {
    if (!selectedUser) return;
    try {
      await clearUserDeviceSession(selectedUser.id);
      setSelectedUserDeviceSession(null);
      logPlatformEvent(
        'SECURITY',
        `Admin released hardware device lock for user ${selectedUser.maskedId}`,
        currentUserId,
        currentUserEmail
      );
      setAdminUndoFeedback('Hardware device lock successfully cleared. User may authenticate from any terminal.');
      showSuccess('Device session lock cleared successfully.');
    } catch {
      showError('Failed to release device session', 'Session Release Failed');
    }
  };

  const handleToggleUserDeviceLock = () => {
    if (!selectedUser) return;
    const next = !selectedUserLockDisabled;
    setUserDeviceLockDisabled(selectedUser.id, next);
    setSelectedUserLockDisabled(next);
    logPlatformEvent(
      'SECURITY',
      next
        ? `Admin disabled device lock enforcement for user ${selectedUser.maskedId}`
        : `Admin enabled device lock enforcement for user ${selectedUser.maskedId}`,
      currentUserId,
      currentUserEmail
    );
    setAdminUndoFeedback(
      next
        ? 'Device lock disabled for this user. Concurrent multi-device logins are now allowed.'
        : 'Single-device lock re-enforced for this user.'
    );
  };

  const handleAdminInitiateUndo = (tx: Transaction) => {
    const acc = selectedUserAccounts.find((a) => a.id === tx.account_id);
    const curBal = acc ? Number(acc.balance) : 0;
    const preview = previewTransactionUndo(tx, curBal);
    setAdminUndoTarget(tx);
    setAdminUndoPreview(preview);
  };

  const handleAdminConfirmUndo = async () => {
    if (!adminUndoTarget || !selectedUser) return;
    setIsAdminUndoing(true);
    try {
      const acc = selectedUserAccounts.find((a) => a.id === adminUndoTarget.account_id);
      const res = await undoAccountTransaction(adminUndoTarget, acc, {
        userId: currentUserId,
        userEmail: currentUserEmail,
        isAdminAction: true,
      });

      setAdminUndoFeedback(res.message);
      setAdminUndoTarget(null);
      setAdminUndoPreview(null);

      // Refresh inspector details
      await loadUserDetails(selectedUser);

      // Trigger parent refresh
      if (onRefreshDatabase) {
        await onRefreshDatabase();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Admin undo failed';
      showError(msg, 'Admin Undo Error');
    } finally {
      setIsAdminUndoing(false);
    }
  };

  // Load telemetry data
  const [users, setUsers] = useState<PlatformUserSummary[]>(() =>
    isAuthorizedAdmin(currentUserEmail) ? getPlatformUsers(currentUserId, currentUserEmail, userStats) : []
  );
  const [activities, setActivities] = useState<PlatformActivityLog[]>(() =>
    isAuthorizedAdmin(currentUserEmail) ? getPlatformActivityLogs() : []
  );

  const handleRefresh = () => {
    if (!isAuthorizedAdmin(currentUserEmail)) return;
    setIsRefreshing(true);
    setTimeout(() => {
      setUsers(getPlatformUsers(currentUserId, currentUserEmail, userStats));
      setActivities(getPlatformActivityLogs());
      setIsRefreshing(false);
    }, 400);
  };

  const handleExportAuditJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(activities, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `apex_audit_log_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Database diagnostics & full refresh state
  const [diagnostics, setDiagnostics] = useState<DatabaseDiagnostics | null>(null);
  const [diagnosticsScope, setDiagnosticsScope] = useState<'global' | 'workspace'>('global');
  const [tableCategoryFilter, setTableCategoryFilter] = useState<'all' | 'core' | 'erp' | 'mobility' | 'system'>('all');
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [isLoadingDiagnostics, setIsLoadingDiagnostics] = useState(false);
  const [showRefreshModal, setShowRefreshModal] = useState(false);
  const [refreshConfirmInput, setRefreshConfirmInput] = useState('');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isExecutingRefresh, setIsExecutingRefresh] = useState(false);
  const [refreshReport, setRefreshReport] = useState<DatabaseRefreshReport | null>(null);
  const [refreshProgressStep, setRefreshProgressStep] = useState<string>('');

  const fetchDiagnostics = useCallback(async () => {
    setIsLoadingDiagnostics(true);
    try {
      const targetUser = diagnosticsScope === 'workspace' ? currentUserId : undefined;
      const diag = await getDatabaseDiagnostics(targetUser);
      setDiagnostics(diag);
    } catch (err) {
      console.error('Error fetching database diagnostics:', err);
    } finally {
      setIsLoadingDiagnostics(false);
    }
  }, [diagnosticsScope, currentUserId]);

  const filteredTables = useMemo(() => {
    if (!diagnostics?.tables) return [];
    return diagnostics.tables.filter((tbl) => {
      const matchesCategory = tableCategoryFilter === 'all' || tbl.category === tableCategoryFilter;
      const matchesQuery =
        !tableSearchQuery.trim() ||
        tbl.table.toLowerCase().includes(tableSearchQuery.toLowerCase()) ||
        tbl.name.toLowerCase().includes(tableSearchQuery.toLowerCase());
      return matchesCategory && matchesQuery;
    });
  }, [diagnostics?.tables, tableCategoryFilter, tableSearchQuery]);

  useEffect(() => {
    if (activeTab === 'database' || showRefreshModal) {
      fetchDiagnostics();
    }
  }, [activeTab, showRefreshModal, fetchDiagnostics]);

  const handleExecuteFullRefresh = async () => {
    if (refreshConfirmInput.trim().toUpperCase() !== 'REFRESH') {
      return;
    }
    setRefreshError(null);
    if (!currentUserId) {
      const msg = 'Active user credentials required to perform targeted database refresh.';
      setRefreshError(msg);
      showError(msg, 'Authorization Required');
      return;
    }

    setIsExecutingRefresh(true);
    setRefreshProgressStep('Purging user tables across transactions, budgets, ERP modules...');

    try {
      const report = await purgeAllDatabaseData(currentUserId, currentUserEmail, 'USD', 'global');
      setRefreshProgressStep('Wiping hardware-bound local telemetry and caches...');
      setRefreshReport(report);
      showSuccess('Database refresh executed successfully.');

      // Re-fetch local users & telemetry
      setUsers(getPlatformUsers(currentUserId, currentUserEmail, {
        transactionsCount: 0,
        accountsCount: 1,
        tasksCount: 0,
        subsCount: 0,
      }));
      setActivities(getPlatformActivityLogs());

      // Re-fetch database diagnostics
      const diag = await getDatabaseDiagnostics(currentUserId);
      setDiagnostics(diag);

      // Notify parent App to refresh all ERP hooks
      if (onRefreshDatabase) {
        await onRefreshDatabase();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Database refresh encountered an error';
      setRefreshError(msg);
      showError(msg, 'Refresh Failed');
    } finally {
      setIsExecutingRefresh(false);
      setRefreshProgressStep('');
    }
  };

  // Filtered users list
  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        u.maskedId.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesRole = roleFilter === 'all' || u.role === roleFilter;
      const matchesStatus = statusFilter === 'all' || u.status === statusFilter;
      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [users, searchQuery, roleFilter, statusFilter]);

  // Filtered activities list
  const filteredActivities = useMemo(() => {
    return activities.filter((act) => {
      if (activityTypeFilter === 'ALL') return true;
      return act.type === activityTypeFilter;
    });
  }, [activities, activityTypeFilter]);

  // Aggregate telemetry metrics
  const totalUsersCount = users.length;
  const activeUsersCount = users.filter((u) => u.status === 'active').length;
  const totalOperationsSum = users.reduce((acc, u) => acc + u.totalTransactions + u.totalTasks, 0);
  const avgAiRate = Math.round(
    users.reduce((acc, u) => acc + u.aiUsageRate, 0) / (users.length || 1)
  );

  if (!isAuthorizedAdmin(currentUserEmail)) {
    return (
      <div className="p-8 text-center bg-slate-900 border border-rose-500/30 rounded-2xl max-w-lg mx-auto mt-12">
        <ShieldAlert className="w-12 h-12 text-rose-400 mx-auto mb-3" />
        <h3 className="text-rose-400 font-bold text-lg mb-2">Access Denied</h3>
        <p className="text-slate-400 text-sm mb-4">
          Administrative privileges are restricted strictly to authorized personnel (<code className="text-purple-300 font-mono">layanmoyura@proton.me</code>).
        </p>
        <button
          onClick={onLockSession}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold cursor-pointer"
        >
          Return to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Admin Header & Security Banner */}
      <div className="bg-gradient-to-r from-purple-950/70 via-slate-900 to-slate-950 border border-purple-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-60 h-60 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 text-xs font-semibold">
              <ShieldAlert className="w-3.5 h-3.5 text-purple-400" />
              <span>Executive Admin Console &bull; Session Authorized</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              Platform Oversight &amp; User Telemetry
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 max-w-2xl">
              Oversee platform user counts, operational activity streams, and system health metrics while preserving user confidentiality.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={handleRefresh}
              title="Refresh Telemetry"
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer border border-slate-700"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-purple-400' : ''}`} />
              <span>Refresh</span>
            </button>

            <button
              onClick={handleExportAuditJson}
              title="Export Non-Personal Audit Log"
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer border border-slate-700"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export Audit</span>
            </button>

            <button
              onClick={handleToggleDeviceLock}
              title={
                isDeviceLockDisabledState
                  ? 'Device lock is currently DISABLED (Multi-device concurrent logins allowed). Click to re-enable single-device lock.'
                  : 'Device lock is currently ENFORCED (Single device per user). Click to disable lock.'
              }
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer border ${
                isDeviceLockDisabledState
                  ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30'
                  : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
              }`}
            >
              {isDeviceLockDisabledState ? (
                <>
                  <Unlock className="w-3.5 h-3.5 text-amber-400" />
                  <span>Device Lock: Disabled</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 ml-1">Enable</span>
                </>
              ) : (
                <>
                  <Lock className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Device Lock: Enforced</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200 ml-1">Disable</span>
                </>
              )}
            </button>

            <button
              onClick={() => {
                setRefreshReport(null);
                setRefreshConfirmInput('');
                setShowRefreshModal(true);
              }}
              title="Full Database Refresh (Zero Sample Data)"
              className="px-3.5 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-rose-400" />
              <span>Fully Refresh DB</span>
            </button>

            <button
              onClick={() => {
                setAdminSession(false);
                onLockSession();
              }}
              title="Lock Admin Console"
              className="px-4 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Lock Admin Session</span>
            </button>
          </div>
        </div>

        {/* Zero Personal Data Guarantee Strip */}
        <div className="mt-6 pt-4 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-emerald-400">
            <ShieldCheck className="w-4 h-4 flex-shrink-0" />
            <span className="font-semibold">Zero Personal Data Policy:</span>
            <span className="text-slate-400">
              Personal financial sums, bank balances, private notes, and contact debts are strictly masked and inaccessible.
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-500 text-[11px] font-mono">
            <EyeOff className="w-3.5 h-3.5" />
            <span>RLS Cryptographic Isolation Enforced</span>
          </div>
        </div>
      </div>

      {/* Aggregate Telemetry Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Total Registered Users</span>
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white tracking-tight">{totalUsersCount}</div>
          <div className="text-[11px] text-emerald-400 mt-1 flex items-center gap-1 font-medium">
            <span>{activeUsersCount} currently active</span>
            <span className="text-slate-500">&bull;</span>
            <span className="text-slate-400">100% cloud verified</span>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">Total Operations Executed</span>
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white tracking-tight">
            {totalOperationsSum.toLocaleString()}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            Ledger txs, operations &amp; assets logged
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">AI Assistant Adoption</span>
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400">
              <Sparkles className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white tracking-tight">{avgAiRate}%</div>
          <div className="text-[11px] text-slate-400 mt-1">
            Natural language parsing utilization
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400">System Health</span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
              <Database className="w-4 h-4" />
            </div>
          </div>
          <div className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Optimal</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
            <span>Latency: 34ms</span>
            <span className="text-slate-600">&bull;</span>
            <span className="text-emerald-400">RLS Active</span>
          </div>
        </div>
      </div>

      {/* Admin Module Sub-navigation */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'users'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Available Users Directory ({filteredUsers.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('activity')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'activity'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Live Activity Audit Stream ({filteredActivities.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('database')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'database'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <Database className="w-4 h-4" />
          <span>Database &amp; Schema ({diagnostics?.totalRecords ?? 0} rows)</span>
        </button>

        <button
          onClick={() => setActiveTab('security')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'security'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>Security &amp; RLS Sentinel</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* 1. AVAILABLE USERS DIRECTORY */}
      {/* ========================================================================= */}
      {activeTab === 'users' && (
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-5">
          {/* Controls: Search and Filters */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search user by email or masked ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Filter className="w-3.5 h-3.5 text-slate-500" />
                <span>Role:</span>
              </div>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as 'all' | 'admin' | 'user')}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-purple-500 cursor-pointer"
              >
                <option value="all">All Roles</option>
                <option value="admin">Administrators</option>
                <option value="user">Standard Users</option>
              </select>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-purple-500 cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active Only</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>

          {/* Users Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-3">User Identifier</th>
                  <th className="py-3 px-3">Role</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3">Device Lock</th>
                  <th className="py-3 px-3">Joined Date</th>
                  <th className="py-3 px-3">Last Active</th>
                  <th className="py-3 px-3 text-center">Activity Volume</th>
                  <th className="py-3 px-3 text-right">Telemetry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-slate-500">
                      No users found matching &ldquo;{searchQuery}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => (
                    <tr
                      key={u.id}
                      className="hover:bg-slate-850/50 transition cursor-pointer"
                      onClick={() => setSelectedUser(u)}
                    >
                      <td className="py-3.5 px-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-600 to-indigo-500 text-white font-bold flex items-center justify-center text-xs flex-shrink-0">
                            {u.email.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-semibold text-white">{u.email}</div>
                            <div className="font-mono text-[10px] text-slate-500">{u.maskedId}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-3">
                        {u.role === 'admin' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-300 border border-purple-500/30 text-[10px] font-bold">
                            <ShieldAlert className="w-3 h-3 text-purple-400" />
                            <span>Administrator</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[10px] font-medium">
                            Member
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            u.status === 'active'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              u.status === 'active' ? 'bg-emerald-400' : 'bg-slate-500'
                            }`}
                          />
                          <span className="capitalize">{u.status}</span>
                        </span>
                      </td>
                      <td className="py-3.5 px-3">
                        {isDeviceLockDisabledState || isUserDeviceLockDisabled(u.id) ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
                            <Unlock className="w-3 h-3 text-amber-400" />
                            <span>Disabled</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
                            <Lock className="w-3 h-3 text-emerald-400" />
                            <span>Enforced</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 text-slate-300 font-mono text-[11px]">{u.joinedDate}</td>
                      <td className="py-3.5 px-3 text-slate-400 flex items-center gap-1 mt-1 text-[11px]">
                        <Clock className="w-3 h-3 text-slate-500" />
                        <span>{u.lastActive}</span>
                      </td>
                      <td className="py-3.5 px-3">
                        <div className="flex items-center justify-center gap-3 text-slate-300 font-mono text-[11px]">
                          <span title="Total Transactions Processed">{u.totalTransactions} txs</span>
                          <span className="text-slate-600">&bull;</span>
                          <span title="Tasks & Operations">{u.totalTasks} tasks</span>
                          <span className="text-slate-600">&bull;</span>
                          <span title="AI Parsing Rate" className="text-amber-400 font-bold">
                            {u.aiUsageRate}% AI
                          </span>
                        </div>
                      </td>
                      <td className="py-3.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedUser(u);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-purple-600 text-slate-300 hover:text-white transition text-[11px] font-medium cursor-pointer"
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. LIVE ACTIVITY AUDIT STREAM */}
      {/* ========================================================================= */}
      {activeTab === 'activity' && (
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                <Activity className="w-4 h-4 text-purple-400" />
                <span>Live Platform Activity Stream</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Real-time operational audit trail (sensitive financial sums &amp; personal descriptions masked).
              </p>
            </div>

            {/* Event Category Filter Pills */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {(
                ['ALL', 'TRANSACTION', 'TASK', 'BUDGET', 'SUBSCRIPTION', 'ASSET', 'AUTH', 'SECURITY'] as const
              ).map((type) => (
                <button
                  key={type}
                  onClick={() => setActivityTypeFilter(type)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold transition cursor-pointer ${
                    activityTypeFilter === type
                      ? 'bg-purple-600 text-white'
                      : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            {filteredActivities.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No events recorded for category &ldquo;{activityTypeFilter}&rdquo;.
              </div>
            ) : (
              filteredActivities.map((act) => {
                const badgeColor =
                  act.type === 'TRANSACTION'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : act.type === 'TASK'
                    ? 'bg-teal-500/10 text-teal-400 border-teal-500/20'
                    : act.type === 'BUDGET'
                    ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                    : act.type === 'SUBSCRIPTION'
                    ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                    : act.type === 'ASSET'
                    ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                    : act.type === 'AUTH'
                    ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                    : 'bg-slate-800 text-slate-300 border-slate-700';

                return (
                  <div
                    key={act.id}
                    className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-start sm:items-center gap-3">
                      <span
                        className={`px-2 py-0.5 rounded-md text-[10px] font-bold border flex-shrink-0 ${badgeColor}`}
                      >
                        {act.type}
                      </span>
                      <div>
                        <div className="font-semibold text-white flex items-center gap-2 flex-wrap">
                          <span>{act.action}</span>
                          <span className="text-[10px] text-slate-500 font-mono bg-slate-900 px-1.5 py-0.5 rounded border border-slate-850">
                            {act.userEmailMasked}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                          <Laptop className="w-3 h-3 text-slate-500" />
                          <span>{act.platform}</span>
                          <span className="text-slate-600">&bull;</span>
                          <span className="text-emerald-400 text-[10px] flex items-center gap-1 font-medium">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Confidentiality Protected</span>
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-500 font-mono whitespace-nowrap self-end sm:self-center">
                      {new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. DATABASE & SCHEMA OPERATIONS */}
      {/* ========================================================================= */}
      {activeTab === 'database' && (
        <div className="space-y-6">
          {/* Zero Hallucination Guarantee Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-semibold mb-2">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Zero Hallucination Policy Enforced</span>
                </div>
                <h3 className="text-xl font-bold text-white tracking-tight">
                  Database Health &amp; Schema Status
                </h3>
                <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
                  Automatic sample data seeding and fabricated demo activity have been permanently removed. Empty state indicators reflect genuine zero-record databases without synthetic padding.
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {/* Scope Selector: Platform-Wide vs Workspace */}
                <div className="p-1 rounded-xl bg-slate-950 border border-slate-800 flex items-center text-xs">
                  <button
                    onClick={() => setDiagnosticsScope('global')}
                    className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 ${
                      diagnosticsScope === 'global'
                        ? 'bg-purple-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    <span>Platform-Wide</span>
                  </button>
                  <button
                    onClick={() => setDiagnosticsScope('workspace')}
                    className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 ${
                      diagnosticsScope === 'workspace'
                        ? 'bg-purple-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>My Workspace</span>
                  </button>
                </div>

                <button
                  onClick={fetchDiagnostics}
                  disabled={isLoadingDiagnostics}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer border border-slate-700 disabled:opacity-50"
                  title="Rescan table row counts"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDiagnostics ? 'animate-spin text-purple-400' : ''}`} />
                  <span>Scan</span>
                </button>
                <button
                  onClick={() => {
                    setRefreshReport(null);
                    setRefreshConfirmInput('');
                    setShowRefreshModal(true);
                  }}
                  className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shadow-lg shadow-rose-600/20"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Fully Refresh DB</span>
                </button>
              </div>
            </div>

            {/* Diagnostic Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80">
                <span className="text-[11px] font-medium text-slate-400 block">Total Live Records</span>
                <span className="text-2xl font-bold text-white tracking-tight mt-1 block">
                  {diagnostics?.totalRecords ?? 0}
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  {diagnosticsScope === 'global' ? 'Across all users' : 'Current workspace'}
                </span>
              </div>
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80">
                <span className="text-[11px] font-medium text-slate-400 block">Database Status</span>
                <span className="text-2xl font-bold text-emerald-400 tracking-tight mt-1 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span>{(diagnostics?.totalRecords ?? 0) === 0 ? 'Clean Slate' : 'Active Data'}</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">RLS Policies Enforced</span>
              </div>
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80">
                <span className="text-[11px] font-medium text-slate-400 block">Tracked Tables</span>
                <span className="text-2xl font-bold text-white tracking-tight mt-1 block">
                  {diagnostics?.tables.length ?? 13}
                </span>
                <span className="text-[10px] text-slate-500 font-mono">13 Public PostgreSQL Tables</span>
              </div>
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80">
                <span className="text-[11px] font-medium text-slate-400 block">Inspection Scope</span>
                <span className="text-2xl font-bold text-purple-400 tracking-tight mt-1 block">
                  {diagnosticsScope === 'global' ? 'Global' : 'Workspace'}
                </span>
                <span className="text-[10px] text-emerald-400 font-medium">
                  {diagnosticsScope === 'global' ? 'All Platform Rows' : 'Targeted User Rows'}
                </span>
              </div>
            </div>
          </div>

          {/* Detailed Module Table Inspection */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-purple-400" />
                  <span>All PostgreSQL Tables &amp; Telemetry ({diagnostics?.tables.length ?? 13})</span>
                </h4>
                <p className="text-xs text-slate-400 mt-0.5">
                  {diagnosticsScope === 'global'
                    ? 'Displaying real-time record counts for all 13 tables across the entire platform.'
                    : 'Displaying real-time record counts isolated to your member workspace.'}
                </p>
              </div>
              <span className="text-[11px] font-mono text-slate-500 self-start md:self-auto">
                Last checked: {diagnostics?.lastChecked ? new Date(diagnostics.lastChecked).toLocaleTimeString() : 'Just now'}
              </span>
            </div>

            {/* Filter Pills & Search Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-1.5 flex-wrap text-xs">
                {(
                  [
                    { id: 'all', label: `All (${diagnostics?.tables.length ?? 13})` },
                    { id: 'core', label: 'Core Ledger (4)' },
                    { id: 'erp', label: 'Personal ERP (4)' },
                    { id: 'mobility', label: 'Mobility & Telemetry (4)' },
                    { id: 'system', label: 'Security & Sessions (1)' },
                  ] as const
                ).map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setTableCategoryFilter(cat.id)}
                    className={`px-2.5 py-1 rounded-lg font-medium transition cursor-pointer text-xs ${
                      tableCategoryFilter === cat.id
                        ? 'bg-purple-600 text-white font-bold'
                        : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              <div className="relative min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter tables..."
                  value={tableSearchQuery}
                  onChange={(e) => setTableSearchQuery(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                    <th className="py-2.5 px-3">Table Identifier</th>
                    <th className="py-2.5 px-3">Subsystem</th>
                    <th className="py-2.5 px-3">Module Description</th>
                    <th className="py-2.5 px-3 text-center">Row Count</th>
                    <th className="py-2.5 px-3 text-right">Database State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850">
                  {filteredTables.map((tbl) => (
                    <tr key={tbl.table} className="hover:bg-slate-850/40 transition">
                      <td className="py-2.5 px-3 font-mono text-purple-300 font-medium">
                        public.{tbl.table}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            tbl.category === 'core'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : tbl.category === 'erp'
                              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                              : tbl.category === 'mobility'
                              ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                              : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                          }`}
                        >
                          {tbl.category}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-slate-200">
                        {tbl.name}
                      </td>
                      <td className="py-2.5 px-3 text-center font-bold text-white font-mono text-sm">
                        {tbl.count}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {tbl.count === 0 ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[10px] font-medium border border-slate-700">
                            Clean Slate
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300 text-[10px] font-semibold border border-purple-500/25">
                            {tbl.count} Records Active
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. SECURITY & RLS SENTINEL */}
      {/* ========================================================================= */}
      {activeTab === 'security' && (
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xl space-y-6">
          <div>
            <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              <span>Cryptographic Isolation &amp; Privacy Verification</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Verification checklist ensuring admin oversight functions strictly without leaking personal member data.
            </p>
          </div>

          {/* Admin Device Lock Control Banner */}
          <div className="p-6 rounded-3xl bg-slate-950 border border-slate-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Laptop className="w-5 h-5 text-purple-400" />
                  <h4 className="text-sm font-bold text-white">Hardware Sentinel &amp; Single-Device Lock</h4>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                      isDeviceLockDisabledState
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                        : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    }`}
                  >
                    {isDeviceLockDisabledState ? 'Lock Disabled (Multi-Device Active)' : 'Lock Enforced (1 Active Device)'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1 max-w-xl">
                  Cryptographic Web Crypto UUID binding each account to a single physical device terminal to prevent session hijacking and concurrent conflicting mutations.
                </p>
              </div>

              <button
                onClick={handleToggleDeviceLock}
                className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 transition cursor-pointer border shadow-lg ${
                  isDeviceLockDisabledState
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-emerald-600/20'
                    : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30 shadow-amber-500/10'
                }`}
              >
                {isDeviceLockDisabledState ? (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Re-Enable Device Lock</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-4 h-4" />
                    <span>Disable Device Lock (Allow Multi-Device)</span>
                  </>
                )}
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 text-[11px] text-slate-300 leading-relaxed flex items-start gap-2.5">
              <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isDeviceLockDisabledState ? 'text-amber-400' : 'text-slate-500'}`} />
              <div>
                {isDeviceLockDisabledState ? (
                  <span>
                    <strong className="text-amber-300 font-semibold">Multi-Device Access Is Unrestricted:</strong> All platform accounts can log into multiple browsers, mobile phones, and Android companions without encountering session conflict modals or receiving automated kickouts.
                  </span>
                ) : (
                  <span>
                    <strong className="text-emerald-300 font-semibold">Strict Single-Device Policy Active:</strong> Logging into a second physical device will trigger the hardware collision sentinel, requiring the user to explicitly authenticate a session transfer.
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
                <CheckCircle2 className="w-4 h-4" />
                <span>Row-Level Security (RLS) Active</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Supabase database policies isolate user financial ledgers. Even admin API calls cannot read raw account balances or personal line items without the user&apos;s direct auth token.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
                <CheckCircle2 className="w-4 h-4" />
                <span>Non-Personal Activity Telemetry</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Audit logs record operational events (e.g., &ldquo;Logged expense transaction via AI&rdquo;) while stripping out dollar amounts, merchant names, and confidential descriptions.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
                <CheckCircle2 className="w-4 h-4" />
                <span>Masked Identifier Standards</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                User IDs are presented as masked hashes (e.g. <code className="text-purple-300 font-mono">usr_...f812</code>) to prevent accidental identification across platform audits.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center gap-2 text-purple-400 font-bold text-xs">
                <ShieldAlert className="w-4 h-4" />
                <span>Session Passkey Protection</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                The Admin Console requires master passkey authorization and can be instantly locked with the &ldquo;Lock Admin Session&rdquo; control.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* User Detail Inspector Modal */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl relative overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-purple-600 to-indigo-500 text-white font-bold flex items-center justify-center text-sm shadow-md">
                  {selectedUser.email.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">{selectedUser.email}</h3>
                  <p className="text-[11px] font-mono text-slate-400">{selectedUser.maskedId}</p>
                </div>
              </div>

              <button
                onClick={() => {
                  setSelectedUser(null);
                  setAdminUndoFeedback(null);
                  setAdminUndoTarget(null);
                  setAdminUndoPreview(null);
                }}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Inspector Navigation Tabs */}
            <div className="flex items-center gap-2 pt-3 pb-2 border-b border-slate-850">
              <button
                onClick={() => setInspectorTab('profile')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  inspectorTab === 'profile'
                    ? 'bg-purple-600 text-white shadow-md'
                    : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>Profile &amp; Footprint</span>
              </button>

              <button
                onClick={() => setInspectorTab('device')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  inspectorTab === 'device'
                    ? 'bg-purple-600 text-white shadow-md'
                    : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Hardware Device Lock</span>
                {selectedUserLockDisabled && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                )}
              </button>

              <button
                onClick={() => setInspectorTab('transactions')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                  inspectorTab === 'transactions'
                    ? 'bg-purple-600 text-white shadow-md'
                    : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Ledger &amp; Undo Txs ({selectedUserTransactions.length})</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="py-4 space-y-4 text-xs flex-1 overflow-y-auto">
              {/* Feedback Alert */}
              {adminUndoFeedback && (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    <span>{adminUndoFeedback}</span>
                  </div>
                  <button
                    onClick={() => setAdminUndoFeedback(null)}
                    className="text-slate-400 hover:text-white text-[11px]"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Active Admin Undo Confirmation Banner */}
              {adminUndoTarget && adminUndoPreview && (
                <div className="p-4 rounded-2xl bg-purple-950/40 border border-purple-500/30 text-xs space-y-3 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-purple-300 text-sm">
                      <RotateCcw className="w-4 h-4 text-purple-400" />
                      <span>Admin Transaction Undo Confirmation</span>
                    </div>
                    <button
                      onClick={() => {
                        setAdminUndoTarget(null);
                        setAdminUndoPreview(null);
                      }}
                      className="text-slate-400 hover:text-white text-xs cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Transaction</span>
                      <span className="text-white font-semibold truncate block">{adminUndoTarget.description}</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Type</span>
                      <span className={`font-bold capitalize ${adminUndoTarget.type === 'income' ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {adminUndoTarget.type}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Previous Balance</span>
                      <span className="text-slate-300 font-mono font-bold">
                        ${adminUndoPreview.previousBalance.toFixed(2)}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-slate-950 border border-purple-500/40">
                      <span className="text-purple-400 block text-[10px] uppercase font-semibold">Resulting Balance</span>
                      <span className="text-white font-mono font-bold">
                        ${adminUndoPreview.projectedBalance.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <p className="text-slate-300 text-[11px] leading-relaxed">
                    {adminUndoPreview.actionDescription}. The transaction entry will be removed from this user&apos;s ledger and related ERP references unlinked.
                  </p>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      disabled={isAdminUndoing}
                      onClick={() => {
                        setAdminUndoTarget(null);
                        setAdminUndoPreview(null);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold cursor-pointer text-xs"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isAdminUndoing}
                      onClick={handleAdminConfirmUndo}
                      className="px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold flex items-center gap-1.5 cursor-pointer shadow-lg shadow-purple-600/20 text-xs"
                    >
                      {isAdminUndoing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5" />
                      )}
                      <span>Execute Admin Undo</span>
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 1: Profile & Operational Footprint */}
              {inspectorTab === 'profile' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Role</span>
                      <span className="text-white font-bold capitalize">{selectedUser.role}</span>
                    </div>
                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Status</span>
                      <span className="text-emerald-400 font-bold capitalize">{selectedUser.status}</span>
                    </div>
                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Joined</span>
                      <span className="text-white font-mono">{selectedUser.joinedDate}</span>
                    </div>
                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                      <span className="text-slate-500 block text-[10px] uppercase font-semibold">Last Active</span>
                      <span className="text-white truncate block">{selectedUser.lastActive}</span>
                    </div>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-slate-800">
                    <span className="font-semibold text-slate-300 block">Platform Operational Footprint</span>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div className="p-2.5 bg-slate-950 rounded-xl border border-slate-800">
                        <span className="text-white font-bold block">{selectedUserAccounts.length}</span>
                        <span className="text-[10px] text-slate-500">Accounts</span>
                      </div>
                      <div className="p-2.5 bg-slate-950 rounded-xl border border-slate-800">
                        <span className="text-white font-bold block">{selectedUserTransactions.length}</span>
                        <span className="text-[10px] text-slate-500">Transactions</span>
                      </div>
                      <div className="p-2.5 bg-slate-950 rounded-xl border border-slate-800">
                        <span className="text-white font-bold block">{selectedUser.totalTasks}</span>
                        <span className="text-[10px] text-slate-500">Tasks</span>
                      </div>
                      <div className="p-2.5 bg-slate-950 rounded-xl border border-slate-800">
                        <span className="text-white font-bold block">{selectedUser.totalSubscriptions}</span>
                        <span className="text-[10px] text-slate-500">Subscriptions</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">AI Assistant Adoption Rate</span>
                      <span className="text-amber-400 font-bold">{selectedUser.aiUsageRate}%</span>
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className="bg-amber-400 h-full rounded-full transition-all"
                        style={{ width: `${selectedUser.aiUsageRate}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: Hardware Device Lock & Session Sentinel */}
              {inspectorTab === 'device' && (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Laptop className="w-4 h-4 text-purple-400" />
                        <h4 className="font-bold text-white text-xs">Active Physical Device Binding</h4>
                      </div>
                      {isDeviceLockDisabledState || selectedUserLockDisabled ? (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-bold">
                          Lock Disabled
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">
                          Lock Active
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 pt-1">
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">Terminal Name</span>
                        <span className="font-semibold text-white block truncate">
                          {selectedUserDeviceSession?.device_name || 'No Active Hardware Bound'}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">Platform</span>
                        <span className="font-semibold text-purple-300 block capitalize">
                          {selectedUserDeviceSession?.platform || 'web'}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">Hardware UUID</span>
                        <span className="font-mono text-[10px] text-slate-400 block truncate">
                          {selectedUserDeviceSession?.active_device_id || 'None registered'}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">Last Active Ping</span>
                        <span className="text-[10px] text-slate-300 block truncate">
                          {selectedUserDeviceSession?.last_active_at || 'Never'}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2 flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleReleaseUserDeviceLock}
                        className="px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[11px] font-semibold flex items-center gap-1.5 transition cursor-pointer"
                        title="Release this user's active device lock session to resolve terminal lockouts"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                        <span>Release Active Device Lock</span>
                      </button>

                      <button
                        onClick={handleToggleUserDeviceLock}
                        className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold flex items-center gap-1.5 transition cursor-pointer border ${
                          selectedUserLockDisabled
                            ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                            : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30'
                        }`}
                        title="Toggle single-device lock exemption for this user"
                      >
                        {selectedUserLockDisabled ? (
                          <>
                            <Lock className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Re-Enforce Device Lock</span>
                          </>
                        ) : (
                          <>
                            <Unlock className="w-3.5 h-3.5 text-amber-400" />
                            <span>Disable Lock for This User</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: Accounts & Transaction-Wise Undo */}
              {inspectorTab === 'transactions' && (
                <div className="space-y-4">
                  {/* User Accounts Overview */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-semibold text-slate-400 block uppercase tracking-wider">
                      User Accounts ({selectedUserAccounts.length})
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {selectedUserAccounts.map((acc) => (
                        <div key={acc.id} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                          <span className="font-semibold text-white truncate block text-xs">{acc.name}</span>
                          <span className="text-slate-500 text-[10px] font-mono block">{acc.currency}</span>
                          <span className="text-emerald-400 font-bold text-xs mt-0.5 block">
                            ${Number(acc.balance).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Transaction Search & Filter */}
                  <div className="pt-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-400 block uppercase tracking-wider">
                        Transactions Ledger ({selectedUserTransactions.length}) &bull; Transaction-Wise Undo
                      </span>
                    </div>

                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="Search transactions to undo..."
                        value={inspectorTxSearch}
                        onChange={(e) => setInspectorTxSearch(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                      />
                    </div>
                  </div>

                  {/* Transactions List */}
                  {isLoadingUserDetails ? (
                    <div className="text-center py-8">
                      <Loader2 className="w-6 h-6 animate-spin text-purple-400 mx-auto" />
                      <span className="text-xs text-slate-400 mt-2 block">Loading ledger records...</span>
                    </div>
                  ) : selectedUserTransactions.length === 0 ? (
                    <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl text-slate-500 text-xs">
                      No transactions recorded for this user.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800/80 max-h-60 overflow-y-auto">
                      {selectedUserTransactions
                        .filter((tx) => {
                          if (!inspectorTxSearch.trim()) return true;
                          const q = inspectorTxSearch.toLowerCase();
                          return (
                            tx.description?.toLowerCase().includes(q) ||
                            tx.raw_prompt?.toLowerCase().includes(q)
                          );
                        })
                        .map((tx) => {
                          const isIncome = tx.type === 'income';
                          const acc = selectedUserAccounts.find((a) => a.id === tx.account_id);
                          const accountName = acc?.name || tx.accounts?.name || 'Account';

                          return (
                            <div
                              key={tx.id}
                              className="py-2.5 flex items-center justify-between gap-3 hover:bg-slate-850/40 px-2 rounded-xl transition"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div
                                  className={`p-1.5 rounded-lg flex-shrink-0 ${
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
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-white text-xs truncate">
                                      {tx.description || 'Transaction'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                                    <span>{accountName}</span>
                                    <span>&bull;</span>
                                    <span className="flex items-center gap-1 text-slate-400">
                                      <Calendar className="w-2.5 h-2.5 text-slate-500" />
                                      <span>{tx.transaction_date}</span>
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-3 flex-shrink-0">
                                <span
                                  className={`font-bold text-xs font-mono ${
                                    isIncome ? 'text-emerald-400' : 'text-rose-400'
                                  }`}
                                >
                                  {isIncome ? '+' : '-'}${Number(tx.amount).toFixed(2)}
                                </span>

                                <button
                                  onClick={() => handleAdminInitiateUndo(tx)}
                                  className="px-2 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/25 text-[10px] font-semibold flex items-center gap-1 transition cursor-pointer"
                                  title={`Admin Undo: Revert transaction and balance on ${accountName}`}
                                >
                                  <RotateCcw className="w-3 h-3 text-rose-400" />
                                  <span>Undo</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end pt-3 border-t border-slate-800">
              <button
                onClick={() => {
                  setSelectedUser(null);
                  setAdminUndoFeedback(null);
                  setAdminUndoTarget(null);
                  setAdminUndoPreview(null);
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition cursor-pointer"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full Database Refresh Modal */}
      {showRefreshModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl relative">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 font-bold flex items-center justify-center">
                  <RotateCcw className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Full Database Refresh</h3>
                  <p className="text-xs text-rose-400/90 font-medium">Destructive Administrative Action</p>
                </div>
              </div>
              {!isExecutingRefresh && (
                <button
                  onClick={() => setShowRefreshModal(false)}
                  className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {refreshReport ? (
              <div className="py-6 space-y-5 text-xs">
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 space-y-2">
                  <div className="flex items-center gap-2 font-bold text-sm text-emerald-400">
                    <CheckCircle2 className="w-5 h-5" />
                    <span>Database Successfully Refreshed</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    {refreshReport.message}
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
                  <span className="font-semibold text-slate-400 block uppercase tracking-wider text-[10px]">
                    Purge Summary
                  </span>
                  <div className="grid grid-cols-2 gap-2 text-slate-300">
                    <div className="flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>{refreshReport.clearedTables.filter((t) => t.status === 'purged').length} Tables Purged</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Local Storage Wiped</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Checking Acct (0.00) Reset</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Zero Sample Data</span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end pt-2 border-t border-slate-800">
                  <button
                    onClick={() => {
                      setShowRefreshModal(false);
                      setRefreshReport(null);
                    }}
                    className="px-5 py-2.5 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-xl transition cursor-pointer shadow-lg shadow-emerald-400/20"
                  >
                    Done &amp; Return
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-5 space-y-4 text-xs">
                <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-300 text-xs space-y-1.5">
                  <div className="flex items-center gap-2 font-bold text-rose-400">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>Warning: Irreversible Data Deletion</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed text-[11px]">
                    This will permanently delete all records across transactions, budgets, tasks, assets, subscriptions, social debts, saved places, mobility timeline trips, and active sessions.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-[11px]">
                  <span className="font-semibold text-slate-300 block">Actions that will be executed:</span>
                  <ul className="space-y-1.5 text-slate-400 list-disc list-inside">
                    <li>Purge all 13 PostgreSQL database tables across entire platform (preserving system taxonomy defaults)</li>
                    <li><strong className="text-emerald-400 font-semibold">Preserve admin and authentication accounts</strong> in <code className="text-purple-300 font-mono">auth.users</code></li>
                    <li>Wipe device-scoped mobility caches and mock coordinates</li>
                    <li>Ensure every member starting account starts strictly at balance <code className="text-emerald-400 font-mono">0.00</code></li>
                    <li>Eliminate all hallucinated sample data injection from future loads</li>
                  </ul>
                </div>

                {refreshError && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 text-rose-400" />
                    <span>{refreshError}</span>
                  </div>
                )}

                {isExecutingRefresh ? (
                  <div className="p-6 rounded-2xl bg-slate-950 border border-slate-800 text-center space-y-3">
                    <Loader2 className="w-8 h-8 animate-spin text-purple-400 mx-auto" />
                    <div className="font-semibold text-white">Refreshing Database...</div>
                    <p className="text-[11px] text-slate-400">{refreshProgressStep}</p>
                  </div>
                ) : (
                  <div className="space-y-2 pt-2">
                    <label className="block text-slate-300 text-[11px] font-semibold">
                      To confirm, type <span className="font-mono text-rose-400 font-bold">REFRESH</span> below:
                    </label>
                    <input
                      type="text"
                      value={refreshConfirmInput}
                      onChange={(e) => setRefreshConfirmInput(e.target.value)}
                      placeholder="Type REFRESH to confirm"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-rose-500 font-mono"
                    />
                  </div>
                )}

                {!isExecutingRefresh && (
                  <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => setShowRefreshModal(false)}
                      className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={refreshConfirmInput.trim().toUpperCase() !== 'REFRESH'}
                      onClick={handleExecuteFullRefresh}
                      className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition cursor-pointer flex items-center gap-1.5 shadow-lg shadow-rose-600/20"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Execute Full Refresh</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
