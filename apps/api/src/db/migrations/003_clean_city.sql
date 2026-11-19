UPDATE vehicles
SET city = trim(substr(city, 1, instr(city, ',') - 1))
WHERE city LIKE '%,%';

UPDATE vehicles SET city = trim(substr(city, 1, length(city) - 5)) WHERE city LIKE '% Heute';
UPDATE vehicles SET city = trim(substr(city, 1, length(city) - 7)) WHERE city LIKE '% Gestern';
UPDATE vehicles SET city = trim(substr(city, 1, length(city) - 11)) WHERE city LIKE '% Vorgestern';

UPDATE vehicles SET city = NULL WHERE city = '';
