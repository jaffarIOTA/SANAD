-- Seed the two target institutions. Codes only; no client names in code (CLAUDE.md §7).
insert into core.tenant (code, name_en, name_ar) values
  ('bank-a',    'Institution A (Islamic bank)', 'المؤسسة أ'),
  ('fintech-b', 'Institution B (fintech)',      'المؤسسة ب')
on conflict (code) do nothing;
