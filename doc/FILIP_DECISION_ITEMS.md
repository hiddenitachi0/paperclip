# Filip's Decision Items for Security Baseline

**Date**: 2026-09-30  
**Context**: Security baseline implementation (DUR-4157)  

This document lists decisions Filip needs to make to complete the security baseline implementation. These decisions are required before full deployment and are marked with priority.

## Critical Decisions (Blockers for Deployment)

### 1. Encrypted Offsite Backups

**Question**: What is the policy for encrypted offsite backups?

**Details**:
- Should database backups be encrypted before transfer to offsite location?
- Which encryption standard and key management approach?
- What geographic location(s) for offsite backup storage?
- Backup retention period for offsite copies?
- Recovery/restore procedures and testing frequency?

**Impact**: Security architecture, disaster recovery capability, compliance

**Decision Made By**: Filip  
**Status**: Pending  

---

### 2. Database Login Changes (DUR-4028)

**Question**: Should we implement the database login changes outlined in DUR-4028?

**Details**:
- DUR-4028 proposes changing database authentication/access patterns
- This may impact operational security and access control
- Requires coordination across infrastructure and engineering teams
- May require migration of existing connections

**Current Status**: [Describe current state from DUR-4028]  
**Impact**: Production database access, operations procedures, security posture  
**Dependencies**: Infrastructure team readiness, downtime planning  

**Decision Made By**: Filip  
**Status**: Pending  

---

### 3. Second Human Approver for Deploys

**Question**: Should we require a second human approver for production deployments?

**Details**:
- Current deployment approval process: [describe current]
- Proposed: Require approval from two independent humans for all production deploys
- Approval chain: [describe chain]
- Exceptions: Emergency hot-fix procedures?
- Approval time impact on deployment process

**Current Practice**: [One approval? Automated?]  
**Desired Practice**: Second approval for compliance and safety  
**Impact**: Deployment velocity, operational friction, blast radius reduction  

**Decision Made By**: Filip  
**Status**: Pending  

---

## High Priority Decisions (Complete Security Baseline)

### 4. Security Contact Email

**Question**: What email address(es) should be used for security vulnerability reports?

**Options**:
- Security team distribution list
- Individual security person's email
- Special security reporting system

**Usage**: Published in SECURITY.md, contact information for security researchers  
**Accessibility**: Should be monitored 24/7 or business hours only?  

**Decision Made By**: Filip  
**Status**: Pending  

---

### 5. Data Controller Information

**Question**: Who is the Data Controller and Data Protection Officer for GDPR purposes?

**Required For**:
- SECURITY.md
- DPA template
- Privacy statements
- Legal and regulatory filings

**Information Needed**:
- Data Controller name and title
- Data Protection Officer name and contact
- Company legal entity name(s)
- Registered address

**Decision Made By**: Filip / Legal  
**Status**: Pending  

---

### 6. Subprocessor Confirmation

**Question**: Which third-party services should be listed as subprocessors?

**Details**:
- Current document has template entries
- Need to fill in actual vendors used for:
  - Cloud infrastructure/hosting
  - Backups and disaster recovery
  - Monitoring and logging
  - Security scanning
  - Communication services

**Template File**: `doc/subprocessor-list.md`  
**Purpose**: Customer transparency, GDPR/CCPA compliance  

**Information Needed**:
- Vendor name
- Service purpose
- Data processed by vendor
- Location(s)
- Data processing agreement status

**Decision Made By**: Filip / Procurement  
**Status**: Pending  

---

### 7. Compliance Roadmap

**Question**: What is the target timeline for SOC 2 Type II certification?

**Details**:
- Document mentions "in progress"
- Need actual target date
- Audit scope and coverage
- Current assessment status

**Also**:
- ISO 27001 timeline?
- Other compliance certifications?
- Audit firm selection?

**Decision Made By**: Filip  
**Status**: Pending  

---

### 8. Data Localization Requirements

**Question**: Where should customer data be stored geographically?

**Details**:
- Current infrastructure location(s)
- EU data residency requirements (GDPR)?
- Multi-region availability needed?
- Backup storage locations

**Template Field**: `doc/dpa-template.md` Section 11  
**Compliance Impact**: GDPR, CCPA, customer contracts  

**Decision Made By**: Filip / Infrastructure  
**Status**: Pending  

---

## Medium Priority Decisions (Best Practices)

### 9. Employee Security Training Content

**Question**: What specific security training topics should be mandatory?

**Suggested Topics**:
- Password security and credential management
- GDPR/privacy training
- Incident response procedures
- Social engineering awareness
- Secure coding practices (for developers)
- Third-party risk management

**Frequency**: Annual minimum? Quarterly updates?  
**Tracking**: How to document compliance?  

**Decision Made By**: Filip / HR / Security  
**Status**: Pending  

---

### 10. Penetration Testing Schedule

**Question**: Should we conduct annual penetration testing or more frequently?

**Details**:
- Current plan: Annual third-party penetration testing
- Option: Semi-annual (spring/fall)?
- Scope: Full infrastructure or targeted?
- Vendor selection criteria?
- Timeline for remediation?

**Decision Made By**: Filip / Security  
**Status**: Pending  

---

### 11. 2FA Enforcement

**Question**: Should 2FA be mandatory for all board users or optional?

**Current Implementation**: Backend/service layer only (TOTP secret generation, verification, recovery codes in `server/src/services/totp-2fa.ts`) — there is no API route or UI wired up yet, so it is not reachable or usable by any board user today, whether mandatory or optional.
**Question**: Once routes/UI are built, make mandatory for all users? Allow exceptions?  
**Rollout**: Immediate or phased?  
**Hardening**: Backup codes, recovery procedures?  

**Decision Made By**: Filip  
**Status**: Pending — not yet implemented end-to-end (service exists, no route/UI)  

---

## Administrative Items

### 12. DEPLOY.md SSH Exposure Claim - Verification Needed

**Issue**: Security documentation mentions DEPLOY.md may expose SSH to the internet

**Action Required**: 
- Filip's assistant should review `doc/DEPLOY.md` or deployment documentation
- Verify if SSH access is exposed to the internet
- If yes: Document the exposure and remediation plan
- If no: Clarify what security practice prevents exposure

**Verification Status**: Pending Filip's assistant review  
**Related Files**: 
- `doc/DEPLOY.md` (if exists)
- Deployment procedures
- Network/firewall configuration

---

### 13. CODEOWNERS Team Names

**Question**: What are the actual GitHub team names for Durkan/Nordstrand?

**Current Status**: Template uses placeholders:
- `@durkan-release-team`
- `@durkan-security-team`

**Action**: Update CODEOWNERS with actual team names/handles from your GitHub organization  
**File**: `.github/CODEOWNERS`

**Decision Made By**: Filip  
**Status**: Pending  

---

### 14. Document Publication & Access

**Question**: Which security documents should be published publicly vs. under NDA?

**Public** (on GitHub):
- SECURITY.md ✓
- CODEOWNERS ✓
- Links to compliance resources ✓

**For Customers** (under NDA or in DPA):
- Security overview
- Incident response plan
- Questionnaire answers
- DPA template

**Decision**: How to distribute these to customers?  
- Email delivery?
- Customer portal?
- GitHub private docs?
- Request-based delivery?

**Decision Made By**: Filip / Product  
**Status**: Pending  

---

## Timeline Summary

| Item | Priority | Blocker? | Estimated Complexity | Decision By | Status |
|------|----------|----------|----------------------|-------------|--------|
| Encrypted Backups | CRITICAL | YES | Medium | Filip | Pending |
| DUR-4028 DB Changes | CRITICAL | YES | High | Filip | Pending |
| 2nd Approver | CRITICAL | YES | Low | Filip | Pending |
| Security Email | HIGH | NO | Low | Filip | Pending |
| Data Controller | HIGH | NO | Low | Filip/Legal | Pending |
| Subprocessors | HIGH | NO | Medium | Filip | Pending |
| Compliance Timeline | HIGH | NO | Low | Filip | Pending |
| Data Location | HIGH | NO | Low | Filip | Pending |
| Training Content | MEDIUM | NO | Low | Filip | Pending |
| Pen Testing | MEDIUM | NO | Low | Filip | Pending |
| 2FA Enforcement | MEDIUM | NO | Low | Filip | Pending |
| DEPLOY.md Verify | MEDIUM | NO | Low | Filip's Asst | Pending |
| CODEOWNERS Names | MEDIUM | NO | Low | Filip | Pending |
| Document Access | MEDIUM | NO | Low | Filip | Pending |

## How to Provide Decisions

For each decision:

1. Review the question and details above
2. Make your decision (or defer if uncertain)
3. Post the decision as a comment on DUR-4157
4. Use this format: **[DECISION ITEM N]**: [Your decision and rationale]

Example:
> **[DECISION ITEM 1]**: Use AWS S3 with AES-256 encryption for offsite backups, daily backup schedule, 90-day retention for offsite copies. Recovery testing quarterly.

## Follow-Up Actions

Once decisions are made, the following will be needed:

1. **Update documents** with specific decisions (security officer team)
2. **Configuration changes** in infrastructure (ops team)
3. **Policy implementation** (HR/ops)
4. **Verification** (Filip's assistant)
5. **Customer communication** if needed (sales/support)
6. **Deployment approval** from Filip

---

**Next Steps**:
- Review decisions list
- Make decisions and post as comments on DUR-4157
- Security team will update documents with decisions
- Target PR merge: After all critical decisions made
