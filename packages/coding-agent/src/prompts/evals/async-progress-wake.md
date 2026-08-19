Run this exact finite command:

`sleep 2 && printf 'MONITOR_READY\n' && sleep 8 && printf 'MONITOR_DONE\n'`

While it runs, report the already-calculated result `323`. When the harness pushes `MONITOR_READY`, acknowledge that event with the exact text `WAKE_ACK MONITOR_READY`.
