import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';

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

      // Route directly into Sonner rich toast system
      if (type === 'error') {
        toast.error(title || 'Error', { description: message, duration });
      } else if (type === 'warning') {
        toast.warning(title || 'Validation Alert', { description: message, duration });
      } else if (type === 'success') {
        toast.success(title || 'Success', { description: message, duration });
      } else {
        toast.info(title || 'Notice', { description: message, duration });
      }

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

  // Global window.alert fallback interceptor so any residual alert() uses Sonner / UI library
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const originalAlert = window.alert;
    window.alert = (msg?: unknown) => {
      toast.warning('Validation Notice', {
        description: String(msg ?? ''),
      });
    };
    return () => {
      window.alert = originalAlert;
    };
  }, []);

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
    </AlertContext.Provider>
  );
};

export const useAlert = (): AlertContextType => {
  const context = useContext(AlertContext);
  if (!context) {
    return {
      alerts: [],
      showAlert: (msg: string) => toast.info(msg),
      showError: (msg: string, title?: string) => toast.error(title || 'Error', { description: msg }),
      showWarning: (msg: string, title?: string) => toast.warning(title || 'Warning', { description: msg }),
      showSuccess: (msg: string, title?: string) => toast.success(title || 'Success', { description: msg }),
      showInfo: (msg: string, title?: string) => toast.info(title || 'Notice', { description: msg }),
      dismissAlert: () => {},
      clearAllAlerts: () => {},
    };
  }
  return context;
};
