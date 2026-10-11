-- The homeowner now outlines the lawn on an aerial photo and the quote is
-- priced from the area of that outline: a fifth origin. The parcel origins
-- stay, for quotes that already carry them.
ALTER TABLE quotes
  DROP CONSTRAINT quotes_origin_check,
  ADD CONSTRAINT quotes_origin_check CHECK (origin IN ('regrid', 'regrid_adjusted', 'bucket', 'manual', 'drawn'));
