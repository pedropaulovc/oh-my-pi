Start this exact command in the background:

`sleep 2 && printf 'MONITOR_READY\n' && sleep 8 && printf 'MONITOR_DONE\n'`

While it runs, calculate 17 × 19 and report the result. When the harness pushes `MONITOR_READY`, acknowledge that event with the exact text `WAKE_ACK MONITOR_READY`.
