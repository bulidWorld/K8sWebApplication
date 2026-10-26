#!/usr/bin/env bash
set -euo pipefail
sudo systemctl start kubescope
sudo systemctl status kubescope --no-pager
