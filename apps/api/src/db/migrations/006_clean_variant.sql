UPDATE vehicles
SET variant = NULLIF(trim(substr(variant, 1, instr(lower(variant), 'nur noch') - 1)), '')
WHERE lower(variant) LIKE '%nur noch % online';
