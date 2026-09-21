#!/usr/bin/env python3
"""
Sanad invariant guard — PreToolUse hook on Edit/Write.

Blocks edits that would violate a Shariah or security invariant from CLAUDE.md.
Exit 2 blocks the tool call and shows stderr to Claude.

These are the invariants most likely to be violated silently by a coding agent
reaching for a familiar lending pattern. Everything else is code review.
"""
import json, re, sys, os

CODE_EXT = {'.ts', '.tsx', '.js', '.jsx', '.sql', '.py', '.go', '.java', '.kt', '.cs', '.rb', '.php'}

# (regex, control, message)
RULES = [
    (r'\b(interest_rate|interestRate|profit_rate|profitRate|accrued_interest|'
     r'accruedInterest|compounding_frequency|compoundingFrequency|penalty_rate|'
     r'penaltyRate|rate_index|rateIndex)\b',
     'SH-01',
     'No interest or rate construct may exist. Return is a profit AMOUNT:\n'
     '  sale_price_amount = cost_amount + profit_amount\n'
     'fixed at inception and immutable. A benchmark may inform the amount at\n'
     'quotation time; no rate is ever persisted. The absence IS the control.'),

    (r'\bapr\b(?!\s*=\s*[\'"]?\w*apr)',
     'SH-01',
     'APR is a rate. See CLAUDE.md §1.1 — express return as a profit amount.'),

    (r'create\s+table\s+(if\s+not\s+exists\s+)?public\.',
     'SH-05',
     'Domain tables must NOT live in the public schema. PostgREST auto-exposes it,\n'
     'which is a direct gate-bypass path — RLS controls who writes a row, not\n'
     'whether the state machine ran. Use core / config / evidence / audit.'),

    (r'(?i)(api[_-]?key|secret|token|password|client[_-]?secret)\s*[:=]\s*'
     r'[\'"][A-Za-z0-9_\-+/=]{20,}[\'"]',
     'SEC',
     'Hardcoded credential. Secrets live in Supabase Vault via\n'
     'config.set_integration_credential(). See docs/SAVING-CREDENTIALS.md.'),
]

# Path-scoped rules: (path fragment, regex, control, message)
SCOPED = [
    ('sequencing', r'\b(new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))',
     'SH-06',
     'The risk period is measured against the external timestamping authority,\n'
     'never the server clock. Use the TSA token time.'),
]


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    ti = payload.get('tool_input') or {}
    path = ti.get('file_path', '') or ''

    # Instructions and docs legitimately name the forbidden things.
    ext = os.path.splitext(path)[1].lower()
    if ext not in CODE_EXT:
        sys.exit(0)

    content = '\n'.join(
        str(ti.get(k, '')) for k in ('content', 'new_string', 'new_source') if ti.get(k)
    )
    if not content.strip():
        sys.exit(0)

    findings = []
    for pattern, control, msg in RULES:
        m = re.search(pattern, content)
        if m:
            findings.append((control, m.group(0), msg))

    low = path.lower()
    for frag, pattern, control, msg in SCOPED:
        if frag in low:
            m = re.search(pattern, content)
            if m:
                findings.append((control, m.group(0), msg))

    if findings:
        out = ['', 'BLOCKED — Sanad invariant violation', '=' * 52]
        for control, match, msg in findings:
            out += ['', f'  [{control}]  matched: {match!r}', '']
            out += ['  ' + line for line in msg.split('\n')]
        out += ['', '=' * 52,
                'These are structural invariants, not style rules. Do not work around',
                'the hook — change the design. See CLAUDE.md §1.', '']
        print('\n'.join(out), file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
