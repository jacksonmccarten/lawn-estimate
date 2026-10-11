-- The questions a company asks homeowners alongside the lawn drawing, as one
-- ordered list per company. Company-scoped through companies' own RLS. Each
-- question: { id (uuid), text, kind ('yes_no' | 'choice'), options (for
-- 'choice'), required }. The shape is checked by the API contract on the way
-- in; the database only holds it to being a list.
--
-- Every company, existing and new, starts with the same five example
-- questions, which the owner can change or remove. The ids only have to be
-- unique within a company.

ALTER TABLE companies
  ADD COLUMN questionnaire jsonb NOT NULL DEFAULT '[
    {"id": "6a1f0c2e-0b0d-4d7e-9c51-3f6d1b1e0a01", "text": "Do you have any gates narrower than 60 inches?", "kind": "yes_no", "options": [], "required": true},
    {"id": "6a1f0c2e-0b0d-4d7e-9c51-3f6d1b1e0a02", "text": "Does your property have any steep hills?", "kind": "yes_no", "options": [], "required": true},
    {"id": "6a1f0c2e-0b0d-4d7e-9c51-3f6d1b1e0a03", "text": "Does your property have a swimming pool?", "kind": "yes_no", "options": [], "required": true},
    {"id": "6a1f0c2e-0b0d-4d7e-9c51-3f6d1b1e0a04", "text": "Are there any obstacles that could make mowing difficult?", "kind": "yes_no", "options": [], "required": true},
    {"id": "6a1f0c2e-0b0d-4d7e-9c51-3f6d1b1e0a05", "text": "Is your backyard accessible to standard lawn mowing equipment?", "kind": "yes_no", "options": [], "required": true}
  ]'::jsonb
  CHECK (jsonb_typeof(questionnaire) = 'array' AND jsonb_array_length(questionnaire) <= 20);
