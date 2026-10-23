import { describe, it, expect } from 'vitest';
import {
  authSchema,
  accountSchema,
  budgetSchema,
  taskSchema,
  transactionReviewSchema,
  assetSchema,
  subscriptionSchema,
} from './validationSchemas';

describe('Zod Form Validation Schemas', () => {
  describe('authSchema', () => {
    it('accepts valid credentials', () => {
      const result = authSchema.safeParse({
        email: 'user@example.com',
        password: 'password123',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid email formats', () => {
      const result = authSchema.safeParse({
        email: 'not-an-email',
        password: 'password123',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('valid email');
      }
    });

    it('rejects passwords shorter than 6 characters', () => {
      const result = authSchema.safeParse({
        email: 'user@example.com',
        password: '123',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 6 characters');
      }
    });
  });

  describe('accountSchema', () => {
    it('accepts valid account details with coerced balance', () => {
      const result = accountSchema.safeParse({
        name: 'Checking Account',
        balance: '1500.50',
        currency: 'USD',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.balance).toBe(1500.5);
      }
    });

    it('rejects empty account name', () => {
      const result = accountSchema.safeParse({
        name: '   ',
        balance: 100,
        currency: 'USD',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('budgetSchema', () => {
    it('accepts valid budget limit', () => {
      const result = budgetSchema.safeParse({
        category_id: 'cat-groceries',
        monthly_limit: '450',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.monthly_limit).toBe(450);
      }
    });

    it('rejects zero or negative budget limit', () => {
      const zeroResult = budgetSchema.safeParse({
        category_id: 'cat-groceries',
        monthly_limit: 0,
      });
      expect(zeroResult.success).toBe(false);

      const negativeResult = budgetSchema.safeParse({
        category_id: 'cat-groceries',
        monthly_limit: -50,
      });
      expect(negativeResult.success).toBe(false);
    });
  });

  describe('taskSchema', () => {
    it('accepts a valid standard task', () => {
      const result = taskSchema.safeParse({
        title: 'Review insurance policy',
        priority: 'high',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priority).toBe('high');
        expect(result.data.is_financial).toBe(false);
      }
    });

    it('rejects a task without a title', () => {
      const result = taskSchema.safeParse({
        title: '',
        priority: 'medium',
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative amounts for financial tasks', () => {
      const result = taskSchema.safeParse({
        title: 'Pay electric bill',
        priority: 'urgent',
        is_financial: true,
        amount: -85,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('transactionReviewSchema', () => {
    it('accepts valid reviewed transaction', () => {
      const result = transactionReviewSchema.safeParse({
        accountId: 'acc-1',
        amount: 25.4,
        type: 'expense',
        description: 'Lunch with team',
        date: '2026-10-22',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing account or zero amount', () => {
      const result = transactionReviewSchema.safeParse({
        accountId: '',
        amount: 0,
        type: 'expense',
        description: 'Coffee',
        date: '2026-10-22',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('assetSchema', () => {
    it('accepts valid asset registration', () => {
      const result = assetSchema.safeParse({
        name: 'MacBook Pro M3',
        purchase_price: '2499',
        current_value: 2100,
        category: 'Electronics',
      });
      expect(result.success).toBe(true);
    });

    it('rejects negative purchase price', () => {
      const result = assetSchema.safeParse({
        name: 'Camera',
        purchase_price: -500,
        current_value: 400,
        category: 'Electronics',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('subscriptionSchema', () => {
    it('accepts valid subscription', () => {
      const result = subscriptionSchema.safeParse({
        name: 'Spotify Premium',
        amount: '11.99',
        billing_cycle: 'monthly',
        renewal_date: '2026-11-01',
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-positive amount', () => {
      const result = subscriptionSchema.safeParse({
        name: 'Gym',
        amount: 0,
        billing_cycle: 'monthly',
        renewal_date: '2026-11-01',
      });
      expect(result.success).toBe(false);
    });
  });
});
