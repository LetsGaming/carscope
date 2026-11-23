UPDATE vehicles SET variant = NULL
WHERE lower(trim(variant)) = lower(make || ' ' || model) OR lower(trim(variant)) = lower(model);

UPDATE vehicles SET variant = trim(substr(variant, length(make) + length(model) + 3))
WHERE lower(variant) LIKE lower(make || ' ' || model || ' %');

UPDATE vehicles SET variant = trim(substr(variant, length(model) + 2))
WHERE lower(variant) LIKE lower(model || ' %');

UPDATE vehicles SET variant = trim(substr(variant, length(make) + 2))
WHERE lower(variant) LIKE lower(make || ' %');

UPDATE vehicles SET variant = NULL WHERE variant = '';
