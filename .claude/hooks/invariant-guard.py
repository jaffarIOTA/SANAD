#!/usr/bin/env python3
"""
Sanad invariant guard — PreToolUse hook on Edit/Write.

Blocks edits that would violate a platform or module invariant from CLAUDE.md.
Exit 2 blocks the tool call and shows stderr to Claude.

Re-scoped 2026-09-25 (ADR 0002). Rates and APR are now legitimate platform
concepts; the no-rate rule applies ONLY inside the Murabaha product module.
Global rules cover the things that are wrong in every module: floating-point
money or rates, domain tables in the exposed schema, hardcoded credentials.
"""
import json, re, sys, os

CODE_EXT = {'.ts', '.tsx', '.js', '.jsx', '.sql', '.py', '.go', '.java', '.kt', '.cs', '.rb', '.php'}

# ---------------------------------------------------------------- global rules
# (regex, control, message)
RULES = [
    (r'create\s+table\s+(if\s+not\s+exists\s+)?public\.',
     'PLAT-01',
     'Domain tables must NOT live in the public schema. PostgREST auto-exposes it,\n'
     'which bypasses the service layer. Use core / config / evidence / audit / products.'),

    (r'(?i)(api[_-]?key|secret|token|password|client[_-]?secret)\s*[:=]\s*'
     r'[\'"][A-Za-z0-9_\-+/=]{20,}[\'"]',
     'SEC',
     'Hardcoded credential. Secrets live in the vault via\n'
     'config.set_integration_credential(). See docs/SAVING-CREDENTIALS.md.'),

    # A rate or APR typed as a JS number is a float in the financial path.
    (r'\b(rate|apr|aprBp|rateBp|profitRate|interestRate|marginBp|benchmarkBp)\s*\??\s*:\s*number\b',
     'PLAT-02',
     'No floating point in the financial path. Rates and APR are integer basis\n'
     'points as bigint: `Rate = { bp: bigint; basis; period }` in core/pricing/rate.ts.\n'
     'Convert for display only, in the <Rate> component.'),

    (r'\b(amount|total|principal|instalment|installment|fee)\w*\s*\??\s*:\s*number\b',
     'PLAT-02',
     'No floating point in the financial path. Money is minor-unit bigint\n'
     '(core/kernel/money.ts). If this is a count rather than money, rename it.'),
]

# ----------------------------------------------------------- path-scoped rules
# (path fragments, regex, control, message)
MURABAHA_PATHS = ('products/murabaha',)

SCOPED = [
    (MURABAHA_PATHS,
     r'\b(interest_rate|interestRate|profit_rate|profitRate|accrued_interest|'
     r'accruedInterest|compounding_frequency|compoundingFrequency|penalty_rate|'
     r'penaltyRate|rate_index|rateIndex|apr|aprBp|rateBp)\b',
     'SH-01',
     'Inside the Murabaha module there is no rate. Return is a profit AMOUNT:\n'
     '  sale_price_amount = cost_amount + profit_amount\n'
     'fixed at inception and immutable. This rule is module-scoped (ADR 0002);\n'
     'rate-priced products live in their own module under products/.'),

    (('sequencing',),
     r'\b(new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))',
     'SH-06',
     'The Murabaha risk period is measured against the external timestamping\n'
     'authority, never the server clock. Use the TSA token time.'),

    (('core/pricing/apr',),
     r'\b(Math\.pow|Math\.exp|Math\.log|parseFloat|toFixed)\b',
     'PLAT-02',
     'APR is computed in integer arithmetic (fixed-point iteration over bigint).\n'
     'No Math.* float helpers in core/pricing/apr.ts.'),
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

    # Test files may name prohibited constructs in order to assert their absence.
    low = path.lower().replace('\\', '/')
    is_test = '/test/' in low or low.endswith('.test.ts') or low.endswith('.test.tsx')
    if is_test:
        sys.exit(0)

    findings = []
    for pattern, control, msg in RULES:
        m = re.search(pattern, content)
        if m:
            findings.append((control, m.group(0), msg))

    for frags, pattern, control, msg in SCOPED:
        if any(frag in low for frag in frags):
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
                'the hook — change the design. See CLAUDE.md §2 and §12.', '']
        print('\n'.join(out), file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
