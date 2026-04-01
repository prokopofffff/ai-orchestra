-- Flow Guard audit log
CREATE TABLE IF NOT EXISTS flow_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  action TEXT NOT NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('allowed', 'rejected')),
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_audit_project_id ON flow_audit(project_id);
CREATE INDEX IF NOT EXISTS idx_flow_audit_status ON flow_audit(status);
CREATE INDEX IF NOT EXISTS idx_flow_audit_created_at ON flow_audit(created_at);
