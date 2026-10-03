# Security Policy

## Reporting Security Vulnerabilities

**Do not open public issues for security vulnerabilities.**

If you discover a security vulnerability in Paperclip, please report it to our security team at **[security reporting email to be added by Filip]** with:

- A description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Your suggested fix (if available)

We take security seriously and will acknowledge receipt within 24 hours and provide a timeline for addressing the issue.

## Security Commitments

Paperclip handles sensitive data and controls agent deployments. We commit to:

- **Confidentiality**: Protecting customer data, API keys, and authentication credentials through encryption at rest and in transit
- **Integrity**: Ensuring only authorized users and agents can make changes via role-based access controls and audit logging
- **Availability**: Maintaining operational resilience with automated backups, monitoring, and incident response procedures

## Security Features

### Authentication & Authorization

- **Board user authentication**: Two-factor authentication (2FA) for board-level access
- **Agent API keys**: Hashed API keys stored at rest with per-company scoping
- **Role-based access control**: Company-scoped access; agents cannot access other companies' data
- **Audit logging**: All mutations recorded with actor identity, timestamp, and resource id

### Data Protection

- **Transport security**: TLS 1.2+ required for all API connections
- **Database access**: Limited credentials, connection pooling, access logging
- **Encryption standards**: Follow industry best practices for sensitive fields
- **Data retention**: Audit logs retained for compliance purposes; refer to Data Processing Agreement

### Secrets Management

- API keys, credentials, and certificates are never committed to the repository
- Sensitive configuration is stored separately from code
- Environment-based configuration for deployment environments

## Company Information

**Operator**: Durkan AS / Nordstrand Technologies  
**Data Controller**: [Filip's details to be added]  
**Data Protection Officer**: [Contact to be added]  

## Compliance & Standards

Paperclip is designed to support regulatory compliance including:

- GDPR (General Data Protection Regulation)
- CCPA (California Consumer Privacy Act)
- SOC 2 commitments (in progress)

Refer to the Data Processing Agreement and Security Overview for detailed compliance information.

## Incident Response

In the event of a suspected security incident:

1. **Report internally**: Contact the security team immediately
2. **Investigation**: Security team will assess scope and impact
3. **Containment**: Affected systems will be isolated if necessary
4. **Notification**: Customers will be notified according to applicable law and our policies
5. **Resolution**: Fix will be developed, tested, and deployed

See `doc/incident-response.md` for detailed procedures.

## Security Questionnaires

Standard industry security questionnaires (such as CAIQ, SIG Lite, or similar assessments) are available upon request and under NDA. Contact our team for questionnaire responses.

## Security Updates

Security patches are released as needed to address vulnerabilities. Subscribe to release notifications or check our releases page for updates.

## Questions?

For security questions that are not vulnerability reports, please contact [security contact to be added].
