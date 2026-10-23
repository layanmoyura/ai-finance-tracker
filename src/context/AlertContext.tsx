import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
} from 'lucide-react';

export type AlertType = 'error' | 'warning' | 'success' | 'info';

export interface AlertItem {
  id: string;
  type: AlertType;
  title?: string;
  message: string;
  duration?: number;
}

export interface AlertContextType {
  alerts: AlertItem[];
  showAlert: (message: string, type?: AlertType, title?: string, duration?: number) => void;
  showError: (message: string, title?: string, duration?: number) => void;
  showWarning: (message: string, title?: string, duration?: number) => void;
  showSuccess: (message: string, title?: string, duration?: number) => void;
  showInfo: (message: string, title?: string, duration?: number) => void;
  dismissAlert: (id: string) => void;
  clearAllAlerts: () => void;
}

const AlertContext = createContext<AlertContextType | null>(null);

export const AlertProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAllAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  const showAlert = useCallback(
    (message: string, type: AlertType = 'info', title?: string, duration = 4500) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newAlert: AlertItem = { id, type, title, message, duration };
      setAlerts((prev) => [...prev, newAlert]);

      if (duration > 0) {
        setTimeout(() => {
          dismissAlert(id);
        }, duration);
      }
    },
    [dismissAlert]
  );

  const showError = useCallback(
    (message: string, title?: string, duration?: number) => {
      showAlert(message, 'error', title || 'Error', duration);
    },
    [showAlert]
  );

  const showWarning = useCallback(
    (message: string, title?: string, duration?: number) => {
      showAlert(message, 'warning', title || 'Validation Notice', duration);
    },
    [showAlert]
  );

  const showSuccess = useCallback(
    (message: string, title?: string, duration?: number) => {
      showAlert(message, 'success', title || 'Success', duration);
    },
    [showAlert]
  );

  const showInfo = useCallback(
    (message: string, title?: string, duration?: number) => {
      showAlert(message, 'info', title || 'Notice', duration);
    },
    [showAlert]
  );

  // Global window.alert fallback interceptor so any residual alert() uses this UI library
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const originalAlert = window.alert;
    window.alert = (msg?: unknown) => {
      showWarning(String(msg ?? ''), 'Validation Notice');
    };
    return () => {
      window.alert = originalAlert;
    };
  }, [showWarning]);

  return (
    <AlertContext.Provider
      value={{
        alerts,
        showAlert,
        showError,
        showWarning,
        showSuccess,
        showInfo,
        dismissAlert,
        clearAllAlerts,
      }}
    >
      {children}
      {/* Toast Alert Notification Container */}
      <div
        role="region"
        aria-live="polite"
        aria-label="Validation Alerts"
        className="fixed top-4 right-4 z-[9999] flex flex-col gap-2.5 max-w-sm sm:max-w-md w-[calc(100vw-2rem)] pointer-events-none"
      >
        {alerts.map((item) => (
          <div
            key={item.id}
            role="alert"
            className={`pointer-events-auto flex items-start gap-3 p-3.5 sm:p-4 rounded-2xl border shadow-2xl backdrop-blur-md transition-all duration-200 animate-in fade-in slide-in-from-top-3 ${
              item.type === 'error'
                ? 'bg-slate-900/95 border-rose-500/40 text-rose-200 shadow-rose-950/40'
                : item.type === 'warning'
                ? 'bg-slate-900/95 border-amber-500/40 text-amber-200 shadow-amber-950/40'
                : item.type === 'success'
                ? 'bg-slate-900/95 border-emerald-500/40 text-emerald-200 shadow-emerald-950/40'
                : 'bg-slate-900/95 border-blue-500/40 text-blue-200 shadow-blue-950/40'
            }`}
          >
            <div className="flex-shrink-0 mt-0.5">
              {item.type === 'error' && (
                <div className="p-1 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <AlertCircle className="w-4 h-4" />
                </div>
              )}
              {item.type === 'warning' && (
                <div className="p-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <AlertTriangle className="w-4 h-4" />
                </div>
              )}
              {item.type === 'success' && (
                <div className="p-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
              )}
              {item.type === 'info' && (
                <div className="p-1 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Info className="w-4 h-4" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0 pr-1">
              {item.title && (
                <h5 className="text-xs font-bold text-white mb-0.5 tracking-tight truncate">
                  {item.title}
                </h5>
              )}
              <p className="text-[11px] sm:text-xs text-slate-300 leading-relaxed break-words font-medium">
                {item.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismissAlert(item.id)}
              className="flex-shrink-0 p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              aria-label="Dismiss alert"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </AlertContext.Provider>
  );
};

export const useAlert = (): AlertContextType => {
  const context = useContext(AlertContext);
  if (!context) {
    // Fallback if rendered outside provider in test environments
    return {
      alerts: [],
      showAlert: (msg: string) => console.log('[Alert]', msg),
      showError: (msg: string) => console.error('[Alert Error]', msg),
      showWarning: (msg: string) => console.warn('[Alert Warning]', msg),
      showSuccess: (msg: string) => console.log('[Alert Success]', msg),
      showInfo: (msg: string) => console.info('[Alert Info]', msg),
      dismissAlert: () => {},
      clearAllAlerts: () => {},
    };
  }
  return context;
};
