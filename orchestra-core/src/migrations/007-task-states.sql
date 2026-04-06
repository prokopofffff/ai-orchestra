-- Add new task states: revisions, failed, cancelled
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
  'new', 'described', 'designing', 'design_ready',
  'in_development', 'pr_created', 'revisions',
  'in_testing', 'tested',
  'in_review', 'approved', 'merged', 'closed',
  'failed', 'cancelled'
));
