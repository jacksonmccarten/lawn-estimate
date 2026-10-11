-- Pennsylvania reference data. Source: docs/COMPLIANCE_REQUIREMENTS.md section 1
-- (61 Pa. Code § 55.6). Changing a flag or a rate here is a compliance change.

-- Snow removal is deliberately absent: § 55.6 does not address it and its
-- taxability is unverified. Add it only once that is settled.
INSERT INTO service_catalog (state, code, name, taxable, note) VALUES
  ('PA', 'mow',                 'Mowing, trimming and edging',            true,  NULL),
  ('PA', 'fertilize',           'Fertilizing and liming',                 true,  NULL),
  ('PA', 'lawn_watering',       'Lawn watering',                          true,  NULL),
  ('PA', 'grass_raking',        'Raking grass',                           true,  NULL),
  ('PA', 'dethatch',            'Dethatching',                            true,  NULL),
  ('PA', 'aerate',              'Aerating',                               true,  NULL),
  ('PA', 'overseed',            'Overseeding an existing lawn',           true,  NULL),
  ('PA', 'sod_existing',        'Sodding an existing lawn',               true,  NULL),
  ('PA', 'lawn_treatment',      'Herbicide, insecticide or fungicide on lawns', true, NULL),
  ('PA', 'shrub_trim_with_lawn', 'Shrub trimming with other lawn work',   true,  'Taxable only because it is done with other lawn work'),
  ('PA', 'soil_test_with_lawn', 'Lawn evaluation or soil test with other lawn services', true, 'Taxable only because it is bought with other lawn services'),
  ('PA', 'shrub_trim',          'Shrub trimming or pruning, standalone',  false, 'Taxable if done with other lawn work'),
  ('PA', 'soil_test',           'Lawn evaluation or soil test, standalone', false, 'Taxable if bought with other lawn services'),
  ('PA', 'new_lawn',            'Seeding or sodding a new lawn',          false, 'Presumed new when tied to construction'),
  ('PA', 'tree_work',           'Tree trimming, pruning, fertilizing, planting or removal', false, NULL),
  ('PA', 'shrub_planting',      'Planting or removing shrubbery',         false, NULL),
  ('PA', 'landscape_design',    'Landscape or lawn design',               false, NULL),
  ('PA', 'bed_maintenance',     'Flower or vegetable bed maintenance',    false, 'Mulch, till, weed, fertilize'),
  ('PA', 'leaf_raking',         'Leaf raking',                            false, 'Non-taxable only when separately stated; bundled with mowing it becomes taxable');

-- 6% statewide, 7% in Allegheny County, 8% in Philadelphia. effective_from is
-- the date we began applying these rates, not the statutory date.
INSERT INTO tax_rates (state, county, rate, effective_from)
SELECT 'PA', county,
       CASE county WHEN 'Allegheny' THEN 0.07 WHEN 'Philadelphia' THEN 0.08 ELSE 0.06 END,
       DATE '2026-01-01'
FROM unnest(ARRAY[
  'Adams', 'Allegheny', 'Armstrong', 'Beaver', 'Bedford', 'Berks', 'Blair', 'Bradford',
  'Bucks', 'Butler', 'Cambria', 'Cameron', 'Carbon', 'Centre', 'Chester', 'Clarion',
  'Clearfield', 'Clinton', 'Columbia', 'Crawford', 'Cumberland', 'Dauphin', 'Delaware',
  'Elk', 'Erie', 'Fayette', 'Forest', 'Franklin', 'Fulton', 'Greene', 'Huntingdon',
  'Indiana', 'Jefferson', 'Juniata', 'Lackawanna', 'Lancaster', 'Lawrence', 'Lebanon',
  'Lehigh', 'Luzerne', 'Lycoming', 'McKean', 'Mercer', 'Mifflin', 'Monroe', 'Montgomery',
  'Montour', 'Northampton', 'Northumberland', 'Perry', 'Philadelphia', 'Pike', 'Potter',
  'Schuylkill', 'Snyder', 'Somerset', 'Sullivan', 'Susquehanna', 'Tioga', 'Union',
  'Venango', 'Warren', 'Washington', 'Wayne', 'Westmoreland', 'Wyoming', 'York'
]) AS county;
