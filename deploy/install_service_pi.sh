#!/bin/sh
# Run on the Raspberry Pi (as the user that owns /home/pi/open890rc):
#   sh install_service_pi.sh
set -e
sudo cp "$(dirname "$0")/open890rc.service" /etc/systemd/system/open890rc.service
sudo systemctl daemon-reload
sudo systemctl enable --now open890rc.service
systemctl status open890rc.service --no-pager
