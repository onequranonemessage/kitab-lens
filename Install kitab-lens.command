#!/bin/bash
# Double-click this in Finder to install kitab-lens. macOS opens it in Terminal;
# it runs install.sh from this folder, then keeps the window open so the result
# (or the error, which also pops up as an alert) can be read before closing.
cd "$(dirname "$0")" || exit 1
clear
/bin/bash ./install.sh "$@"
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "All done. To start kitab-lens, double-click \"Start kitab-lens.command\" in this folder."
else
  echo "The install stopped -- see the message above. Double-click this file again after fixing it."
fi
read -r -p "Press Return to close this window. " _
exit "$status"
