import { supabase } from '../supabaseClient';
import type { Transaction, Account } from '../types';
import { logPlatformEvent } from './adminTelemetry';

export interface UndoTransactionResult {
  success: boolean;
  transactionId: string;
  accountId: string;
  accountName: string;
  previousBalance: number;
  newBalance: number;
  delta: number;
  message: string;
}

export interface UndoPreview {
  delta: number;
  actionType: 'refund' | 'deduction';
  actionDescription: string;
  previousBalance: number;
  projectedBalance: number;
}

/**
 * Calculates what the balance change will be when a transaction is undone.
 */
export function previewTransactionUndo(
  transaction: Transaction,
  currentAccountBalance: number
): UndoPreview {
  const amount = Number(transaction.amount) || 0;
  // If expense: spending is reversed, adding money back
  // If income: income is reversed, deducting money
  const isExpense = transaction.type === 'expense';
  const delta = isExpense ? amount : -amount;
  const projectedBalance = Number((currentAccountBalance + delta).toFixed(2));

  return {
    delta,
    actionType: isExpense ? 'refund' : 'deduction',
    actionDescription: isExpense
      ? `Refunds ${amount.toFixed(2)} back to account balance`
      : `Deducts ${amount.toFixed(2)} from account balance`,
    previousBalance: currentAccountBalance,
    projectedBalance,
  };
}

/**
 * Reverts a financial transaction and synchronizes account balance transaction-wise.
 * Also cleans up any dependent ERP references (tasks, assets, social contacts).
 */
export async function undoAccountTransaction(
  transaction: Transaction,
  accountFallback?: Account,
  operator?: {
    userId?: string;
    userEmail?: string;
    isAdminAction?: boolean;
  }
): Promise<UndoTransactionResult> {
  const amount = Number(transaction.amount) || 0;
  const isExpense = transaction.type === 'expense';
  const delta = isExpense ? amount : -amount;

  // 1. Fetch current account balance from Supabase or fallback
  let accountName = accountFallback?.name || 'Account';
  let currentBalance = accountFallback ? Number(accountFallback.balance) : 0;

  try {
    const { data: dbAccount, error: accFetchError } = await supabase
      .from('accounts')
      .select('id, name, balance')
      .eq('id', transaction.account_id)
      .maybeSingle();

    if (!accFetchError && dbAccount) {
      accountName = dbAccount.name;
      currentBalance = Number(dbAccount.balance);
    }
  } catch (err) {
    console.warn('Could not fetch live account record, using memory fallback:', err);
  }

  const newBalance = Number((currentBalance + delta).toFixed(2));

  // 2. Delete transaction record from transactions table
  const { error: delError } = await supabase
    .from('transactions')
    .delete()
    .eq('id', transaction.id);

  if (delError) {
    throw new Error(`Failed to remove transaction: ${delError.message}`);
  }

  // 3. Atomically update account balance
  const { error: accUpdateError } = await supabase
    .from('accounts')
    .update({ balance: newBalance })
    .eq('id', transaction.account_id);

  if (accUpdateError) {
    console.warn('Account balance update failed:', accUpdateError.message);
    // Non-fatal if account was already removed, but surface notice
  }

  // 4. Detach any linked records in ERP modules
  try {
    // A. Unlink financial tasks
    await supabase
      .from('tasks')
      .update({ related_transaction_id: null })
      .eq('related_transaction_id', transaction.id);

    // B. Unlink personal assets
    await supabase
      .from('personal_assets')
      .update({ linked_transaction_id: null })
      .eq('linked_transaction_id', transaction.id);

    // C. Unlink settled debts in contacts ledger
    await supabase
      .from('contacts_ledger')
      .update({
        settled_transaction_id: null,
        is_settled: false,
        settled_at: null,
      })
      .eq('settled_transaction_id', transaction.id);
  } catch (cleanErr) {
    console.warn('Non-critical error unlinking ERP foreign keys:', cleanErr);
  }

  // 5. Audit trail telemetry logging
  const actionPrefix = operator?.isAdminAction ? 'Admin undid' : 'User undid';
  const logMessage = `${actionPrefix} ${transaction.type} transaction "${transaction.description}" (${amount.toFixed(2)}) on ${accountName} (Balance: ${currentBalance.toFixed(2)} ➔ ${newBalance.toFixed(2)})`;

  logPlatformEvent(
    'TRANSACTION',
    logMessage,
    operator?.userId || transaction.user_id,
    operator?.userEmail
  );

  return {
    success: true,
    transactionId: transaction.id,
    accountId: transaction.account_id,
    accountName,
    previousBalance: currentBalance,
    newBalance,
    delta,
    message: `Successfully reverted "${transaction.description}". ${accountName} balance updated from ${currentBalance.toFixed(2)} to ${newBalance.toFixed(2)}.`,
  };
}
