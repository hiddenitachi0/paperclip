# Incident Response Plan

**Version**: 1.0  
**Last Updated**: 2026-09-30  
**Owner**: Security Team  

## Overview

This document outlines Durkan/Nordstrand's incident response procedures for security incidents affecting Paperclip, customer data, or infrastructure. The goal is to detect, contain, investigate, and remediate security issues while minimizing harm and customer impact.

## Incident Classifications

### Severity Levels

**Critical** (P0): Immediate threat to data confidentiality, integrity, or availability
- Unauthorized access to production systems
- Data breach affecting customer information
- Service outage affecting multiple customers
- Malware or ransomware detected
- **Response time**: 0-15 minutes for containment

**High** (P1): Significant security risk requiring urgent action
- Vulnerability with active exploitation
- Unauthorized system modification
- Suspicious account activity
- **Response time**: 15-60 minutes for initial response

**Medium** (P2): Security concern requiring attention
- Vulnerability without known exploitation
- Failed access attempts
- Configuration drift
- **Response time**: 1-4 hours for initial response

**Low** (P3): General security observation
- Policy violations
- Unconfirmed reports
- **Response time**: Next business day

## Response Phases

### 1. Detection

**Responsibility**: Monitoring and alert systems, team observations

- Automated alerts from monitoring systems
- Customer reports through support channels
- Security team investigation
- Third-party notifications (security researchers, etc.)

**Actions**:
- Acknowledge receipt of report
- Document initial details (time, nature, evidence)
- Classify severity level
- Activate incident response team

### 2. Containment

**Responsibility**: Incident Commander, Security Team, Infrastructure Team

**Immediate** (first 15 minutes for Critical):
- Isolate affected systems from production if necessary
- Revoke compromised credentials
- Block malicious IP addresses
- Enable additional logging and monitoring

**Short-term** (first few hours):
- Preserve evidence for investigation
- Prevent further escalation
- Establish incident command structure
- Notify management and legal if required

### 3. Investigation

**Responsibility**: Security Team, applicable team leads

- Determine scope of incident
- Identify root cause
- Assess impact (what data was accessed, systems affected)
- Timeline reconstruction
- Identify affected customers/records

### 4. Remediation

**Responsibility**: Engineering teams, guided by investigation findings

- Patch vulnerable systems
- Fix configuration issues
- Deploy security updates
- Reset affected user sessions/credentials
- Verify fixes are effective

### 5. Notification

**Responsibility**: Legal, Management, Customer Support

**Timelines** (follows applicable law):
- **GDPR**: Notification to supervisory authority within 72 hours if personal data is compromised
- **CCPA**: Notification to affected individuals without unreasonable delay
- **Internal**: Immediate notification to affected systems and stakeholders

**Notification content**:
- What happened
- When it was discovered and contained
- What impact may affect them
- What we're doing to fix it
- Resources for further questions

### 6. Recovery

**Responsibility**: Operations, Engineering

- Restore systems from known-good backups if needed
- Verify data integrity
- Monitor for signs of re-compromise
- Return to normal operations

### 7. Post-Incident

**Responsibility**: Security Team, Team Leads

- Conduct post-mortem meeting
- Document lessons learned
- Update this plan and security measures
- Communicate findings (internal and external if applicable)
- Update customers on preventive measures

## Incident Response Team

### Roles

**Incident Commander**: Coordinates response efforts, makes containment decisions
- **Escalation**: Security Team Lead → CTO → CEO

**Security Lead**: Investigates technical details, determines scope and impact
- Availability: On-call rotations

**Infrastructure Lead**: Manages system isolation, patches, and recovery
- Availability: On-call rotations

**Customer Communications Lead**: Manages external notifications and customer inquiries
- Availability: Business hours primary, escalation for after-hours

**Legal**: Advises on notification obligations and regulatory requirements
- Contact: [Filip/Legal team contact]

### On-Call Rotation

[To be configured by Filip's team based on organization structure]

## Containment Procedures

### Data Breach

1. Stop data flow from compromised systems
2. Identify what data was accessed
3. Count affected records
4. Preserve evidence
5. Revoke potentially-compromised credentials

### Malware/Compromise

1. Isolate affected host from network
2. Disable services if safe to do so
3. Preserve memory dump and logs
4. Scan for persistence mechanisms
5. Assess if other systems are affected

### Denial of Service

1. Enable DDoS protection if available
2. Route traffic to backup infrastructure
3. Block known malicious sources
4. Increase monitoring
5. Coordinate with ISP/CDN if external

### Credential Compromise

1. Revoke compromised API keys and credentials
2. Force password reset for affected users
3. Revoke active sessions
4. Review access logs for unauthorized activity
5. Enable additional authentication factors

## Evidence Preservation

For all incidents:
- Preserve logs (application, system, network, audit)
- Document system state (screenshots, outputs)
- Collect memory dumps if relevant
- Maintain chain of custody
- Store securely, limit access

**Retention**: At least 90 days for active investigation, per legal guidance

## Recovery Procedures

### Backup & Restore

- Regular backups are tested and verified
- Recovery Time Objective (RTO): [To be determined]
- Recovery Point Objective (RPO): [To be determined]
- Restore procedure documented in `doc/backup-and-recovery.md`

### Data Integrity Verification

After any data incident or restoration:
1. Verify checksums/signatures
2. Spot-check sample records
3. Confirm audit logs are consistent
4. Run integrity checks

## Communication

### Internal Escalation

```
Team Member → Team Lead → CTO → CEO (for Critical)
Team Member → Team Lead → Security Lead (for High/Medium)
```

### External Communication

- **Customers**: Via support, email
- **Regulators**: Via formal notification channels per jurisdiction
- **Public**: Press release if significant incident
- **Media**: CEO/PR handles media inquiries

### Message Templates

[To be developed with legal and communications team]

## Training and Drills

- Annual security training for all employees
- Quarterly incident response drills
- New team members receive incident response orientation
- After-action reviews after actual incidents

## Review and Updates

This plan will be reviewed annually and updated when:
- Regulatory requirements change
- Significant organizational changes occur
- After any real incident
- When new technologies or processes are introduced

**Next review date**: 2027-09-30

## Appendix A: Contact Information

[To be filled in by Filip's team]

- Security Team Lead: [name, email, phone]
- Infrastructure Lead: [name, email, phone]
- Customer Communications: [email, phone]
- Legal Contact: [name, email, phone]
- CEO/Decision Maker: [name, email, phone]

## Appendix B: External Resources

- **GDPR Breach Notification**: https://edpb.ec.europa.eu/
- **CCPA Notifications**: https://oag.ca.gov/privacy/databreach
- **CISA Incident Response**: https://www.cisa.gov/incident-management
- **NIST Cybersecurity Framework**: https://www.nist.gov/cyberframework
