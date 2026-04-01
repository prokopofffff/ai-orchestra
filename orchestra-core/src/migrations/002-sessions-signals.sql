-- Agent sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('tech-lead', 'designer', 'frontend', 'backend', 'qa', 'devops')),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  claude_session_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'sleeping', 'terminated', 'crashed')),
  model TEXT NOT NULL DEFAULT 'sonnet',
  worktree_path TEXT,
  last_heartbeat TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- Signals
CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_project_id ON signals(project_id);
CREATE INDEX IF NOT EXISTS idx_signals_to_role ON signals(to_role);
CREATE INDEX IF NOT EXISTS idx_signals_read ON signals(read);

-- Rate limiter queue
CREATE TABLE IF NOT EXISTS task_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 40,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
