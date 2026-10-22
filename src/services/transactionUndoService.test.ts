import { describe, it, expect } from 'vitest';
import { previewTransactionUndo } from './transactionUndoService';
import type { Transaction } from '../types';

describe('Transaction Undo Service', () => {
  it('should calculate correct refund for expense undo', () => {
    const expenseTx: Transaction = {
      id: 'tx-1',
      user_id: 'user-1',
      account_id: 'acc-1',
      category_id: 'cat-1',
      amount: 75.5,
      type: 'expense',
      description: 'Dinner at restaurant',
      transaction_date: '2026-10-22',
      created_at: new Date().toISOString(),
    };

    const preview = previewTransactionUndo(expenseTx, 200.0);
    expect(preview.delta).toBe(75.5);
    expect(preview.actionType).toBe('refund');
    expect(preview.projectedBalance).toBe(275.5);
  });

  it('should calculate correct deduction for income undo', () => {
    const incomeTx: Transaction = {
      id: 'tx-2',
      user_id: 'user-1',
      account_id: 'acc-1',
      category_id: 'cat-2',
      amount: 1500,
      type: 'income',
      description: 'Bonus payment',
      transaction_date: '2026-10-22',
      created_at: new Date().toISOString(),
    };

    const preview = previewTransactionUndo(incomeTx, 3000.0);
    expect(preview.delta).toBe(-1500);
    expect(preview.actionType).toBe('deduction');
    expect(preview.projectedBalance).toBe(1500);
  });
});
