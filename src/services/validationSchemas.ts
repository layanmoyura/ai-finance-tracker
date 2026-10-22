import { z } from 'zod';

/**
 * Authentication Credentials Schema (Login & Sign Up)
 */
export const authSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email address is required')
    .email('Please enter a valid email address (e.g. you@domain.com)'),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters long')
    .max(100, 'Password is too long'),
});

export type AuthFormData = z.infer<typeof authSchema>;

/**
 * Account Creation & Edit Schema
 */
export const accountSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Account name is required')
    .max(50, 'Account name cannot exceed 50 characters'),
  balance: z.coerce
    .number()
    .finite('Balance must be a finite number'),
  currency: z
    .string()
    .trim()
    .min(1, 'Currency is required'),
});

export type AccountFormData = z.infer<typeof accountSchema>;

/**
 * Monthly Budget Allocation Schema
 */
export const budgetSchema = z.object({
  category_id: z
    .string()
    .trim()
    .min(1, 'Please select a spending category'),
  monthly_limit: z.coerce
    .number()
    .positive('Budget limit must be greater than zero')
    .max(100000000, 'Budget limit exceeds maximum allowed'),
});

export type BudgetFormData = z.infer<typeof budgetSchema>;

/**
 * ERP Task & Bill Payable Schema
 */
export const taskSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Task title is required')
    .max(120, 'Title cannot exceed 120 characters'),
  description: z.string().max(500, 'Description cannot exceed 500 characters').optional().default(''),
  due_date: z.string().optional().default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  is_financial: z.boolean().default(false),
  financial_type: z.enum(['payable', 'receivable', 'none']).default('none'),
  amount: z.coerce
    .number()
    .min(0, 'Amount cannot be negative')
    .default(0),
  category_id: z.string().optional().default(''),
  account_id: z.string().optional().default(''),
  recurrence_rule: z.string().default('none'),
});

export type TaskFormData = z.infer<typeof taskSchema>;

/**
 * AI Transaction Review & Save Schema
 */
export const transactionReviewSchema = z.object({
  accountId: z
    .string()
    .trim()
    .min(1, 'Please select an account for this transaction'),
  categoryId: z.string().optional().default(''),
  amount: z.coerce
    .number()
    .positive('Transaction amount must be greater than zero')
    .max(100000000, 'Transaction amount exceeds maximum allowable value'),
  type: z.enum(['income', 'expense']),
  description: z
    .string()
    .trim()
    .min(1, 'Transaction description is required')
    .max(100, 'Description cannot exceed 100 characters'),
  date: z
    .string()
    .trim()
    .min(1, 'Transaction date is required'),
});

export type TransactionReviewFormData = z.infer<typeof transactionReviewSchema>;

/**
 * Personal Asset Vault Schema
 */
export const assetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Asset name is required')
    .max(100, 'Asset name cannot exceed 100 characters'),
  purchase_price: z.coerce
    .number()
    .min(0, 'Purchase price cannot be negative'),
  current_value: z.coerce
    .number()
    .min(0, 'Current value cannot be negative'),
  category: z
    .string()
    .trim()
    .min(1, 'Asset category is required'),
  purchase_date: z.string().optional().default(''),
});

export type AssetFormData = z.infer<typeof assetSchema>;

/**
 * Recurring Subscription Schema
 */
export const subscriptionSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Subscription name is required')
    .max(100, 'Subscription name cannot exceed 100 characters'),
  amount: z.coerce
    .number()
    .positive('Subscription amount must be greater than zero'),
  billing_cycle: z.enum(['monthly', 'yearly', 'quarterly', 'weekly']),
  renewal_date: z
    .string()
    .trim()
    .min(1, 'Renewal date is required'),
  account_id: z.string().optional().default(''),
  category_id: z.string().optional().default(''),
});

export type SubscriptionFormData = z.infer<typeof subscriptionSchema>;
