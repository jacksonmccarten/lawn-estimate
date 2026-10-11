-- A lead is decided once. After `decision` is set, neither it nor the adjusted
-- total can change; other columns (notified_at) still can. The trigger raises
-- SQLSTATE LQ001, which POST /leads/{id}/decision answers with
-- 409 lead_already_decided. It holds for every role and closes the race
-- between two operators deciding at the same moment: the second UPDATE waits
-- for the first, then sees the decision and fails.
CREATE FUNCTION leads_decision_final() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL
     AND (NEW.decision IS DISTINCT FROM OLD.decision
          OR NEW.adjusted_total_cents IS DISTINCT FROM OLD.adjusted_total_cents) THEN
    RAISE EXCEPTION 'lead % is already %', OLD.id, OLD.decision USING ERRCODE = 'LQ001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER leads_decision_final
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_decision_final();

-- An adjusted total only exists on an accepted lead.
ALTER TABLE leads ADD CONSTRAINT leads_adjusted_total_needs_accept
  CHECK (adjusted_total_cents IS NULL OR decision = 'accepted');
