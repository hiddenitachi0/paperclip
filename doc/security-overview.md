# Paperclip Security Overview

**Version**: 1.0  
**Last Updated**: 2026-09-30  
**Audience**: Paperclip Customers and Partners  

## Executive Summary

Paperclip is a control plane for AI agent companies, handling sensitive deployment, orchestration, and execution data. We take security seriously and have designed Paperclip with strong security controls to protect your data and maintain your trust.

This document describes Paperclip's security architecture, practices, and commitments.

## What We Protect

**Your Data**:
- Customer company data and configurations
- Agent deployments and orchestration state
- API keys, credentials, and secrets
- Audit logs and activity history
- Any data your agents process

**Your Control**:
- Only your authorized users can access your company's data
- Agents operate only on data you grant them access to
- Changes are logged and attributable
- You can export your data at any time

## Security Architecture

### Multi-Tenant Isolation

Paperclip enforces company-scoped isolation:

- **Data Separation**: Each company's data is isolated at the database level
- **Access Control**: API requests are validated against company ownership
- **Cross-Company Blocking**: One company cannot access another's data
- **Audit Trail**: All accesses are logged with company context

### Authentication

**Board Users** (your team members):
- Username/password authentication
- Two-factor authentication (2FA) available for enhanced security
- Session tokens stored securely
- Automatic session expiration

**Agent API Keys**:
- Cryptographically random key generation
- Hashed at rest in the database
- Per-company scoping enforced
- Automatic rotation capability

### Authorization

- **Role-based access control**: Users have defined roles (board user, agent, etc.)
- **Resource ownership**: Users can only access resources within their company
- **Minimum privilege**: Agents run with minimal required permissions
- **Approval gates**: Sensitive actions require explicit approval

### Encryption

**In Transit**:
- TLS 1.2+ for all API communications
- Certificate pinning available for high-security environments

**At Rest**:
- Sensitive fields encrypted with industry-standard algorithms
- API keys hashed with salted algorithms
- Database encryption supported

**Key Management**:
- Encryption keys stored separately from data
- Key rotation procedures in place
- Access to keys is audited

## Operational Security

### Monitoring & Alerting

- Continuous monitoring of system health and security events
- Automated alerts for suspicious activity
- Intrusion detection systems
- Real-time security dashboards

### Incident Response

- Documented incident response procedures
- 24/7 on-call security team
- Rapid containment procedures
- Customer notification procedures per applicable law

### Backups & Disaster Recovery

- Regular automated backups
- Backup integrity verification
- Tested recovery procedures
- Geographic backup redundancy (if applicable)

### Vulnerability Management

- Regular security audits and penetration testing
- Dependency scanning for known vulnerabilities
- Vulnerability disclosure program
- Rapid patching procedures

## Compliance & Standards

Paperclip is designed to meet regulatory requirements:

### GDPR (General Data Protection Regulation)

- Data processing agreements in place
- Data subject access request procedures
- Right to be forgotten (data deletion) support
- Privacy by design principles

### CCPA (California Consumer Privacy Act)

- Consumer privacy rights respected
- Data sale restrictions honored
- Opt-out procedures available
- Transparency in data usage

### SOC 2

- Working toward SOC 2 Type II certification
- Controls in place for security, availability, and confidentiality
- Regular audits and assessments

### Industry Standards

- NIST Cybersecurity Framework alignment
- OWASP security best practices
- Secure coding standards

## Data Handling

### Data Retention

- Customer data retained as configured
- Audit logs retained for minimum 1 year
- Deleted data removed within 30 days
- Backup retention per backup policy

### Data Localization

- [To be specified by Filip]: Data location and compliance

### Third-Party Access

We may share data with:
- **Subprocessors**: Listed in `doc/subprocessor-list.md`
- **Law Enforcement**: Only with valid legal process
- **Regulators**: Only as required by law

Full details in Data Processing Agreement.

## Your Responsibilities

While Paperclip provides strong security controls, your security also depends on:

- **Credential Security**: Keep your API keys and passwords secure; never share them
- **Access Control**: Grant team member access only to those who need it
- **Updates**: Regularly update Paperclip and your clients to patch vulnerabilities
- **Monitoring**: Monitor your agent activity for suspicious behavior
- **Reporting**: Report security concerns to our security team immediately

## Security Features by Release

### Current Release

- Two-factor authentication (2FA) for board users
- Comprehensive audit logging
- Company-scoped data isolation
- API key management with hashing
- TLS-encrypted communications
- Role-based access control

### Planned

- [Specific future security features, to be filled in]
- Hardware security key support
- Advanced threat detection
- Zero-trust architecture elements

## Reporting a Security Vulnerability

If you discover a security vulnerability in Paperclip:

1. Do not open a public issue
2. Email our security team at [security email to be added]
3. Include details: description, reproduction steps, impact
4. Allow us time to investigate and fix

We take security reports seriously and will respond within 24 hours.

## Support & Questions

For security questions or compliance requirements:

- **Email**: [security contact email to be added]
- **DPA/Legal**: [legal contact email to be added]
- **Technical Support**: [support channel to be added]

## Document Information

- **Classification**: Public (customer-facing)
- **Last Updated**: 2026-09-30
- **Next Review**: 2027-09-30
- **Owner**: Security Team

---

*Paperclip is committed to maintaining strong security practices and being transparent with our customers about security. This document represents our current practices and commitments. As our platform evolves, we will continue to strengthen our security posture and keep this document updated.*
