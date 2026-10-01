# Two-Factor Authentication (2FA/TOTP) Implementation

**Version**: 1.0  
**Status**: Core implementation complete, API routes and UI integration pending  
**Security Review**: REQUIRED before merge  

## Overview

This document describes the two-factor authentication (2FA) implementation for Paperclip board users using Time-based One-Time Passwords (TOTP).

## Architecture

### TOTP Algorithm

- **Specification**: RFC 6238 (TOTP: Time-Based One-Time Password Algorithm)
- **Library**: speakeasy (Node.js TOTP library)
- **Secret Length**: 32 bytes (high entropy)
- **Encoding**: Base32 (for QR code display)
- **Window**: 2-step tolerance (±30-second window for clock drift)

### Database Schema

#### user_totp_secrets
Stores TOTP secrets for users with 2FA enabled:
- `id`: Primary key
- `user_id`: Reference to authUsers
- `secret`: Base32-encoded TOTP secret
- `verified`: Boolean flag (true when setup is complete)
- `enabled_at`: Timestamp when 2FA was activated
- `disabled_at`: Soft-delete timestamp for disabled 2FA
- **Constraint**: Maximum one active TOTP secret per user (UNIQUE where disabled_at IS NULL)

#### user_recovery_codes
Stores hashed recovery codes for account recovery:
- `id`: Primary key
- `user_id`: Reference to authUsers
- `code_hash`: SHA-256 hash of recovery code (not plaintext)
- `used_at`: When the code was consumed (null = unused)
- **Format**: Codes are 8 uppercase hex digits formatted as XXXX-XXXX
- **Count**: 10 codes generated per setup

#### totp_session_tokens
Tracks successful 2FA verification in sessions:
- `id`: Primary key
- `user_id`: Reference to authUsers
- `session_id`: Session ID for cross-reference
- `verified_at`: When 2FA was verified
- `expires_at`: When session verification expires (default 30 minutes)
- **Purpose**: Prevents repeated 2FA prompts within session lifetime

#### authUsers (extended)
- `totp_required`: Whether 2FA is mandatory for this user (future feature)
- `totp_verified_at`: Last successful 2FA verification timestamp

### Service Layer (totp-2fa.ts)

#### Setup Flow
```
initiateTotpSetup(userId, userEmail)
  → Returns: secret (base32), qrCode (PNG), recoveryCodes (10 codes)
  → QR code: "Paperclip (user@example.com)" issuer format
  → Codes stored in browser until completeTotpSetup called

completeTotpSetup(userId, secret, token, recoveryCodes)
  → Validates TOTP token matches secret
  → Stores verified secret (marked as verified = true)
  → Stores hashed recovery codes
  → Records totpVerifiedAt timestamp
```

#### Verification Flow
```
validateAndConsumeTotpToken(userId, token, isRecoveryCode)
  → If TOTP token:
    - Fetch active TOTP secret
    - Verify token within ±30-second window
    - Return valid/invalid with recovery code count
  
  → If recovery code:
    - Hash provided code
    - Find matching code_hash
    - Verify code not yet used_at
    - Mark code as used
    - Return remaining recovery codes
```

#### Session Tracking
```
recordTotpSessionVerification(userId, sessionId, ttlMs)
  → Creates totp_session_tokens entry
  → Default TTL: 30 minutes
  → Used to suppress re-prompting within session
  
verifySessionTotpStatus(userId, sessionId)
  → Checks if recent successful verification exists
  → Returns boolean (verified or not)
```

## Security Considerations

### Secrets Protection
- TOTP secrets stored encrypted at rest (per Paperclip encryption policy)
- Base32 encoding used for QR code display (not plaintext hexadecimal)
- Secret never transmitted over unsecured channels
- Secret deleted when 2FA is disabled

### Recovery Code Security
- **Hashed at rest**: SHA-256 hash stored, never plaintext
- **One-time use**: Each code can only be used once
- **Consumption tracked**: usedAt timestamp prevents replay
- **Count limited**: 10 codes generated, users warned when running low
- **Regeneration**: Users should regenerate codes if compromised
- **Backup codes**: Should be stored securely by user (printed or in password manager)

### Timing-Safe Comparisons
- Token validation uses speakeasy library (timing-safe comparison built-in)
- Recovery code hashes use timing-safe comparison (constant-time to resist timing attacks)

### Session Verification
- Session tokens tracked separately from TOTP secrets
- Prevents TOTP bypass via session fixation
- 30-minute default TTL prevents day-long unverified sessions
- Separate verification required for sensitive operations

### Threat Mitigations

| Threat | Mitigation |
|--------|-----------|
| QR code interception | TOTP is time-based; QR code alone doesn't compromise security |
| Secret recovery | 10 recovery codes for account recovery |
| Bruteforce TOTP | 6-digit tokens, ±30-second window, rate limiting (to be implemented) |
| Recovery code recovery | Hashed at rest; recovery requires database compromise |
| Session hijacking | Separate 2FA session verification required |
| Timestamp attacks | speakeasy library uses cryptographic time comparison |

## Implementation Status

### Completed ✓
- Database schema and migration (0206_totp_2fa.sql)
- TOTP service implementation (totp-2fa.ts)
- Security-focused service design
- Documentation (this file)

### Pending - API Routes ⏳
- POST /api/auth/totp/setup/initiate - Start 2FA setup
- POST /api/auth/totp/setup/complete - Verify and store 2FA
- POST /api/auth/totp/verify - Verify TOTP or recovery code
- GET /api/auth/totp/status - Get current 2FA status
- POST /api/auth/totp/disable - Disable 2FA
- POST /api/auth/totp/recovery-codes/regenerate - Generate new codes

### Pending - UI Integration ⏳
- 2FA setup flow in user settings
- QR code display for setup
- Recovery code display and download
- TOTP input during login/sensitive operations
- Recovery code input option
- Session re-verification for sensitive operations

### Pending - Enforcement ⏳
- Require 2FA for board users
- Configuration for mandatory 2FA per company
- Grace period for rollout
- Enforcement middleware

## API Endpoint Design

```typescript
// Setup
POST /api/auth/totp/setup/initiate
→ { secret: string; qrCode: string; recoveryCodes: string[] }

POST /api/auth/totp/setup/complete
← { token: string; recoveryCodes: string[] }
→ { success: boolean }

// Verification
POST /api/auth/totp/verify
← { token: string } | { recoveryCode: string }
→ { valid: boolean; remainingRecoveryCodes: number }

// Status & Management
GET /api/auth/totp/status
→ { enabled: boolean; enabledAt: Date; remainingRecoveryCodes: number }

POST /api/auth/totp/disable
← { password: string } // Require password for account security
→ { success: boolean }

POST /api/auth/totp/recovery-codes/regenerate
← { password: string }
→ { recoveryCodes: string[] }
```

## Testing

### Unit Tests Needed
- TOTP token generation and verification
- Recovery code hashing and validation
- Session token TTL expiration
- Unique constraint on active secrets
- Recovery code consumption logic
- Edge cases (clock skew, concurrent requests)

### Integration Tests Needed
- Complete setup flow (initiate → verify → complete)
- Login with TOTP token
- Login with recovery code
- Recovery code consumption tracking
- Session verification flow
- 2FA disable flow

### Security Tests Needed
- TOTP token outside time window rejects correctly
- Recovery code cannot be reused
- Secrets not leaked in logs or error messages
- Timing-safe comparisons don't leak information
- Concurrent TOTP verifications handled correctly

## Deployment Considerations

### Database Migrations
- Run migration 0206_totp_2fa.sql to create tables
- Existing users unaffected (no required fields)
- Soft-delete via disabledAt allows historical tracking

### Configuration
- TOTP_WINDOW_TOLERANCE: Default 2 steps (±30 seconds)
- RECOVERY_CODES_COUNT: Default 10 per setup
- SESSION_TOTP_TTL_MS: Default 30 * 60 * 1000 (30 minutes)
- TOTP_ISSUER: Default "Paperclip"

### Rollout Strategy
1. Deploy code and run migration (no enforcement yet)
2. Make 2FA setup available in user settings
3. Monitor adoption and issue reports
4. Gather feedback for UI/UX improvements
5. Enable optional 2FA requirement per company
6. Eventually require 2FA for board-level access

## Security Review Checklist

Before merging, Security Reviewer should verify:

- [ ] TOTP secret generation uses cryptographically secure randomness (speakeasy)
- [ ] Recovery codes hashed with SHA-256 (not reversible)
- [ ] Timing-safe comparisons prevent timing attacks
- [ ] TOTP window tolerance (±30 seconds) is appropriate
- [ ] Session verification TTL (30 min) is appropriate
- [ ] No secrets leaked in logs, errors, or responses
- [ ] Recovery codes are one-time use (consumed correctly)
- [ ] Unique constraint on active TOTP secret per user
- [ ] No SQL injection vectors in queries
- [ ] Rate limiting needed for TOTP verification attempts (not yet implemented)
- [ ] API endpoints require proper authentication
- [ ] Session verification required for sensitive operations
- [ ] Database encryption at rest covers TOTP secrets
- [ ] Password confirmation required for setup/disable operations
- [ ] Migration properly handles existing data
- [ ] Service handles null/missing secrets gracefully

## Future Enhancements

1. **WebAuthn/FIDO2**: Hardware security key support
2. **Backup Codes**: Alternative recovery mechanism
3. **Authenticator Apps**: Support for Authy, Microsoft Authenticator, etc.
4. **Rate Limiting**: Prevent TOTP bruteforce attacks
5. **Device Trust**: Remember devices to reduce 2FA prompts
6. **Biometric 2FA**: Support for fingerprint/face (OS-level)
7. **SMS/Email Backup**: Alternative 2FA methods
8. **Admin Override**: Secure admin re-authentication bypass
9. **Audit Logging**: Track 2FA setup/disable/verify events
10. **Mandatory 2FA**: Policy enforcement per company

## References

- [RFC 6238 - TOTP](https://tools.ietf.org/html/rfc6238)
- [speakeasy npm package](https://www.npmjs.com/package/speakeasy)
- [NIST SP 800-63B - Authentication](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [OWASP - Multi-Factor Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

## Questions for Security Review

1. Is SHA-256 for recovery code hashing sufficient, or should we use bcrypt/argon2?
2. Should we implement rate limiting in this PR or as a follow-up?
3. Is ±30-second TOTP window appropriate, or should it be adjustable?
4. Should 2FA setup require password confirmation for verification?
5. Should we audit-log all 2FA-related events?
6. Is 30-minute session TOTP TTL appropriate for different user roles?
7. Should WebAuthn support be prioritized in next iteration?
