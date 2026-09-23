#!/bin/bash
while true; do
  curl -s http://localhost:3000/api/cron/update-rate > /dev/null
  sleep 300
done
