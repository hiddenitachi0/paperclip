# Security Questionnaire Answers

**Version**: 1.0  
**Last Updated**: 2026-09-30  
**Basis**: Cloud Security Alliance's Standard Assessment Initiative (SIG) Lite questionnaire  

This document contains Paperclip's responses to standard security questions commonly asked by customers and partners during due diligence and compliance assessments.

## Organization & Governance

**Q: Does your organization have a documented information security policy?**

A: Yes. Paperclip maintains a comprehensive information security policy covering:
- Access control and authentication
- Data protection and encryption
- Incident response procedures
- Employee responsibilities
- Third-party management
- Regular security training
- Policy review and updates

The policy is reviewed annually and updated as needed based on organizational changes or threat landscape evolution.

**Q: Who is responsible for information security within your organization?**

A: Durkan AS / Nordstrand Technologies has designated a security team responsible for:
- Developing and maintaining security policies
- Conducting risk assessments and compliance reviews
- Managing vendor security
- Incident response coordination
- Security training and awareness

A Data Protection Officer is responsible for GDPR/privacy compliance.

**Q: Do you conduct regular risk assessments?**

A: Yes. We conduct:
- Annual comprehensive risk assessments
- Quarterly threat and vulnerability assessments
- Ongoing monitoring for emerging threats
- Risk assessment after any security incident or significant system change
- Risk assessments for new subprocessors

## Access Control

**Q: How do you manage user access to systems and data?**

A: Access control is managed through:
- Role-based access control (RBAC) - users have specific roles with defined permissions
- Multi-factor authentication (MFA/2FA): backend/service support exists (TOTP secret generation, verification, recovery codes) but is not yet wired up to any route or UI, so it is not currently enforced or available to board user accounts
- API key authentication for agent integrations
- Company-scoped access - users can only access their company's data
- Regular access reviews - access privileges reviewed quarterly
- Principle of least privilege - users have minimum required permissions
- Automatic session expiration - idle sessions timeout after defined period

**Q: Do you enforce strong password policies?**

A: Yes, we enforce:
- Minimum length of 12 characters
- Complexity requirements (upper, lower, numbers, special characters)
- Password history - users cannot reuse recent passwords
- Password expiration - periodic password change requirements
- Two-factor authentication: implemented at the backend/service level, not yet available to users (no route or UI wired up yet)

**Q: How are credentials for shared systems managed?**

A: Shared system credentials:
- Are not hardcoded in application code
- Are stored in a secure secrets management system
- Have limited access restricted to authorized personnel
- Are rotated on a defined schedule
- Are audited for usage
- Have automatic access revocation when employees leave

**Q: What authentication methods are available for users?**

A: Authentication methods include:
- Username and password
- Two-factor authentication (2FA) using time-based one-time passwords (TOTP): built at the backend/service level (secret generation, verification, recovery codes) but not yet wired up to an API route or UI, so it is not currently usable by board users
- API key authentication for agents
- Session-based authentication for board users
- Automatic logout on session expiration or device logout

## Data Protection

**Q: How is personal data protected?**

A: Personal data is protected through:
- Encryption in transit (TLS 1.2+)
- Encryption at rest for sensitive fields
- Access controls limiting who can view data
- Audit logging of all data access
- Data retention policies with automatic deletion
- Secure backup procedures
- Anonymization where feasible

**Q: What encryption standards do you use?**

A: We use industry-standard encryption:
- **In Transit**: TLS 1.2 or higher
- **At Rest**: AES-256 for sensitive data
- **Key Management**: Cryptographic keys stored separately from encrypted data
- **Algorithms**: Follow NIST and industry recommendations

**Q: How do you manage encryption keys?**

A: Encryption keys are managed through:
- Secure key storage separate from encrypted data
- Limited access to key management systems
- Audit logging of key access and use
- Key rotation procedures on defined schedule
- Backup procedures for disaster recovery
- No key material in application logs or error messages

**Q: How long do you retain customer data?**

A: Data retention periods:
- **Customer Data**: Retained per customer configuration, default [X months]
- **Audit Logs**: Retained for minimum 1 year for compliance
- **Backups**: Retained per backup retention policy, minimum [X days]
- **Deleted Data**: Purged from production within 30 days; backups follow retention schedule
- **Request to Delete**: Customer-requested data deleted within [timeframe]

## Security Monitoring & Incident Response

**Q: Do you monitor systems for security events?**

A: Yes, comprehensive monitoring includes:
- Real-time security event detection
- Automated alerting for suspicious activities
- Intrusion detection systems (IDS/IPS)
- Log aggregation and analysis
- Security information and event management (SIEM) tools
- 24/7 monitoring coverage
- Regular review of monitoring logs

**Q: What incidents trigger your incident response plan?**

A: Incidents triggering formal response include:
- Unauthorized access or attempted access
- Data breach or suspected data breach
- Malware or compromise detection
- Denial of service attacks
- Data corruption or integrity issues
- Loss of system availability
- Third-party security notifications
- Regulatory inquiries

**Q: How do you respond to security incidents?**

A: Our incident response process:
1. **Detection & Reporting**: Alert monitoring systems and incident team
2. **Assessment**: Determine severity and scope of incident
3. **Containment**: Isolate affected systems and stop ongoing damage
4. **Investigation**: Determine root cause and extent of compromise
5. **Remediation**: Fix root cause and patch vulnerabilities
6. **Recovery**: Restore systems to known-good state
7. **Notification**: Notify customers per applicable law (within 72 hours for GDPR)
8. **Post-Incident**: Conduct review and update procedures

**Q: What is your mean time to detect (MTTD) and mean time to respond (MTTR)?**

A: Incident response timelines:
- **Critical Severity**: Detection within minutes, response within 15 minutes
- **High Severity**: Response within 1 hour
- **Medium Severity**: Response within 4 hours
- **Low Severity**: Response within 1 business day
- **MTTD (Mean Time to Detect)**: Average [X minutes] for security events
- **MTTR (Mean Time to Respond)**: Average [Y minutes] from detection to initial response

## Business Continuity & Disaster Recovery

**Q: Do you have a disaster recovery plan?**

A: Yes, we maintain:
- Documented disaster recovery procedures
- Regular backup procedures with integrity testing
- Geographically distributed backups [if applicable]
- Tested recovery procedures (quarterly recovery drills)
- Defined Recovery Time Objective (RTO): [X hours]
- Defined Recovery Point Objective (RPO): [Y hours]
- Off-site backup storage
- Emergency response team training

**Q: How often are backups tested?**

A: Backup testing:
- Automated backup integrity verification daily
- Quarterly recovery drills restoring to test environment
- Annual full production disaster recovery test
- Post-incident recovery testing
- Annual review of backup retention

**Q: What is your service availability/uptime?**

A: Service availability:
- Target uptime: [99.X%] per year
- Maintenance windows: [scheduled times, e.g., Sunday 2-4 AM UTC]
- Status page: [URL for real-time status]
- Incident communication: [communication method during outages]

## Vendor Management

**Q: Do you perform security assessments of subprocessors/vendors?**

A: Yes, vendor management includes:
- Pre-engagement security assessment
- Verification of security certifications (SOC 2, ISO 27001, etc.)
- Review of security practices and controls
- Contractual requirements for data protection
- Annual reassessment of critical vendors
- Continuous monitoring for security issues

**Q: What are your vendor selection criteria?**

A: Vendors must:
- Pass security due diligence assessment
- Provide SOC 2 Type II report or equivalent
- Sign data processing agreements
- Have insurance coverage (cyber liability, E&O)
- Demonstrate financial stability
- Have a track record of reliability
- Maintain secure coding and development practices

**Q: Do you have a vendor breach notification process?**

A: Yes, we require:
- Vendors notify us immediately of security incidents affecting our data
- Incident details provided within 24 hours
- Cooperation with investigation
- Remediation plan within 48 hours
- Regular vendor security audits

## Compliance

**Q: What compliance standards do you meet?**

A: We comply with:
- **GDPR** (General Data Protection Regulation) - personal data protection
- **CCPA** (California Consumer Privacy Act) - California privacy rights
- **Contractual Requirements** - customer-specific compliance obligations
- **Industry Standards** - following NIST, OWASP best practices
- **SOC 2** - working toward Type II certification
- **Emerging Standards** - ISO 27001 assessment in progress

**Q: Do you perform penetration testing?**

A: Yes, penetration testing:
- Annual third-party penetration testing
- Ad-hoc testing before major releases
- Vulnerability scanning weekly
- Bug bounty program [if applicable]
- Remediation of findings tracked to closure
- Reports available under NDA

**Q: Do you have liability insurance?**

A: Yes, Paperclip is covered by:
- Cyber liability insurance
- Professional liability insurance (E&O)
- Additional insurance for compliance obligations
- Coverage details available upon request under NDA

## Data Subject Rights

**Q: How do customers fulfill data subject rights requests?**

A: We support data subject rights:
- **Access**: Provide copy of personal data in common format
- **Rectification**: Correct inaccurate personal data
- **Erasure**: Delete personal data upon request
- **Restriction**: Stop processing but retain data
- **Portability**: Provide data in machine-readable format
- **Objection**: Stop processing for non-essential purposes
- **Automation Rights**: Human review of automated decisions

Process:
- Customer submits request via [support channel]
- We respond within [10 business days] where feasible
- We charge no fee unless request is excessive
- We assist customer in responding to data subjects

## Employees & Training

**Q: Do employees receive security training?**

A: Yes, security training includes:
- Annual mandatory information security training
- Data protection and privacy training per GDPR
- Incident response procedures training
- Secure coding practices for developers
- Third-party risk management training
- Regular security awareness updates and newsletters
- Training tracked and documented

**Q: What background checks are performed?**

A: Background checks:
- Background check required for all employees with system access
- Periodic re-screening for long-term employees
- Checks performed per local legal requirements
- Documented and maintained

**Q: What is your employee offboarding process?**

A: Employee offboarding:
- Immediate revocation of access upon termination
- Return of equipment and credentials
- Removal from mailing lists and access groups
- Audit of access for any violations
- No access to company systems post-termination

## Communication & Transparency

**Q: How do you communicate security issues to customers?**

A: Communication includes:
- Incident notifications per GDPR (within 72 hours)
- Security advisories for vulnerabilities
- Status page updates during outages
- Regular security updates via email/portal
- Direct contact for affected customers
- Root cause analysis post-incident

**Q: Do you have a responsible disclosure/bug bounty program?**

A: Yes, security researchers can:
- Report vulnerabilities via [security email]
- Expect response within 24 hours
- Receive regular updates on investigation progress
- Get credit (if desired) upon public disclosure
- [Details of bug bounty program if applicable]

**Q: Can we audit your security controls?**

A: Yes, customers can:
- Request SOC 2 reports annually
- Request third-party penetration testing reports (under NDA)
- Submit audit questionnaires (we respond within 10 business days)
- Request specific security documentation
- Coordinate on-site audits [subject to terms]

## Questions & Clarifications

For additional security questions or clarifications:

- **Email**: [security@durkan.tld]
- **DPO Contact**: [dpo@durkan.tld]
- **Response Time**: We respond to security questionnaires within 10 business days
- **NDA**: Can sign NDA if requested for sensitive information

---

**Note**: This document provides general information. Specific implementation details and security measures are documented in:
- `doc/security-overview.md` - Complete security architecture
- `doc/incident-response.md` - Detailed incident procedures
- `doc/subprocessor-list.md` - Third-party processor list
- `doc/dpa-template.md` - Data processing agreement
- SOC 2 / Audit Reports - Available upon request

*Document current as of 2026-09-30. Subject to change. Customers should request latest version for due diligence.*
