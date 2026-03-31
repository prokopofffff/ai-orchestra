#!/bin/bash
# OpenProject post-start initialization script
# Run after OpenProject is fully up: docker compose exec openproject /app/openproject-init.sh

set -e

echo "=== OpenProject Initialization ==="

# Wait for Rails to be ready
until RAILS_ENV=production bundle exec rails runner "puts 'ready'" 2>/dev/null; do
  echo "Waiting for OpenProject to be ready..."
  sleep 5
done

# Activate all pending users
echo "Activating pending users..."
RAILS_ENV=production bundle exec rails runner "
  pending = User.where(status: [0, 4]) # registered or invited
  if pending.any?
    pending.update_all(status: 1)
    puts \"Activated #{pending.count} user(s)\"
  else
    puts 'No pending users'
  end
"

# Generate API token if not exists
echo "Checking API token..."
RAILS_ENV=production bundle exec rails runner "
  admin = User.admin.first
  unless admin
    puts 'ERROR: No admin user found'
    exit 1
  end

  existing = Token::API.where(user: admin).first
  if existing
    puts \"API token already exists for #{admin.login}\"
  else
    token = Token::API.create!(user: admin)
    puts \"API_TOKEN=#{token.plain_value}\"
    puts 'Save this token in your .env as OPENPROJECT_API_KEY'
  end
"

echo "=== OpenProject initialization complete ==="
