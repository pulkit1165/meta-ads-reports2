#!/bin/bash
# Off-box copy of the astro bot's hourly DB backups (conversations, payments, question quota).
# Runs on the Mac so the data survives even if the EC2 instance itself is lost, not just DB
# corruption on the same box (backup_db.py on EC2 already covers that case).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/backups"
rsync -az -e "ssh -i $HOME/.ssh/antriksh_aws" \
  ec2-user@3.108.101.235:/home/ec2-user/astro-bot/backups/ "$HERE/backups/"
# Keep 30 days locally -- this is the deep archive, EC2 already holds the last 14 days.
find "$HERE/backups" -name "astro-*.db" -mtime +30 -delete
