-- Correct a known status-only extraction. Preserve text, evidence and review status.
UPDATE claims SET type = 'property_fact', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'ai' AND review_status = 'pending' AND type = 'next_action'
  AND current_version_id IN (
    SELECT id FROM claim_versions WHERE lower(trim(statement)) IN (
      'the buyer has not yet obtained pre-approval or spoken with a lender.',
      'the buyer has not yet obtained mortgage pre-approval or spoken with a lender.',
      'the buyer has not yet obtained pre-approval.',
      'the buyer has not yet obtained mortgage pre-approval.'
    )
  );
