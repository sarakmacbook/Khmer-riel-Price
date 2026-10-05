#!/bin/bash

# Poll every 10 seconds by default for near-real-time Telegram alerts. Override
# RATE_UPDATE_INTERVAL_SECONDS when running against a slower bank/source.
INTERVAL_SECONDS=${RATE_UPDATE_INTERVAL_SECONDS:-10}

while true; do
  curl -fsS -H "Authorization: Bearer ${CRON_SECRET:-}" \
    http://localhost:3000/api/cron/update-rate > /dev/null || true
  sleep "$INTERVAL_SECONDS"
done
