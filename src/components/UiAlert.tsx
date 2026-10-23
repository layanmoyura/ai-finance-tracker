import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export interface UiAlertProps {
  type?: 'error' | 'warning' | 'success' | 'info';
  title?: string;
  message: string;
  onClose?: () => void;
  className?: string;
}

export const UiAlert: React.FC<UiAlertProps> = ({
  type = 'error',
  title,
  message,
  onClose,
  className = '',
}) => {
  const getStyles = () => {
    switch (type) {
      case 'error':
        return {
          wrapper: 'bg-rose-500/10 border-rose-500/20 text-rose-300',
          icon: <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />,
          title: 'text-rose-400',
        };
      case 'warning':
        return {
          wrapper: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
          icon: <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />,
          title: 'text-amber-400',
        };
      case 'success':
        return {
          wrapper: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
          icon: <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />,
          title: 'text-emerald-400',
        };
      case 'info':
      default:
        return {
          wrapper: 'bg-blue-500/10 border-blue-500/20 text-blue-300',
          icon: <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />,
          title: 'text-blue-400',
        };
    }
  };

  const style = getStyles();

  return (
    <div
      role="alert"
      className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs ${style.wrapper} ${className}`}
    >
      {style.icon}
      <div className="flex-1 min-w-0">
        {title && <div className={`font-semibold mb-0.5 ${style.title}`}>{title}</div>}
        <div className="leading-relaxed font-medium">{message}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-white p-0.5 rounded cursor-pointer transition flex-shrink-0"
          aria-label="Dismiss alert"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
