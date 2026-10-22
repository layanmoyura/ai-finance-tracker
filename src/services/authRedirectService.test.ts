import { describe, it, expect, beforeEach } from 'vitest';
import { parseAuthFeedbackFromUrl, getAuthRedirectUrl } from './authRedirectService';

describe('Auth Redirect Service', () => {
  beforeEach(() => {
    // happy-dom allows resetting window.location.href
    window.location.href = 'http://localhost:5173/';
  });

  it('should detect email verification from hash parameters', () => {
    window.location.href = 'http://localhost:5173/#access_token=xyz123&type=signup';

    const feedback = parseAuthFeedbackFromUrl();
    expect(feedback.isVerified).toBe(true);
    expect(feedback.error).toBeNull();
  });

  it('should detect and format expired OTP verification errors', () => {
    window.location.href = 'http://localhost:5173/#error=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

    const feedback = parseAuthFeedbackFromUrl();
    expect(feedback.isVerified).toBe(false);
    expect(feedback.error).toContain('expired');
  });

  it('should format base URL correctly with trailing slash', () => {
    window.location.href = 'https://example.com/ai-finance-tracker/index.html';

    const redirect = getAuthRedirectUrl();
    expect(redirect).toBe('https://example.com/ai-finance-tracker/');
  });
});
