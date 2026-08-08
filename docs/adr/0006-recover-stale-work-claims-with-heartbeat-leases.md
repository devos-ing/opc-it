# Recover stale Work Claims with heartbeat leases

An active Work Claim will renew its Claim Lease with a heartbeat every five minutes. After thirty minutes without a heartbeat, the fifteen-minute Reconciliation Sweep may release and requeue the Work Issue without consuming its Recovery Budget; only an outage that prevents execution for twenty-four continuous hours becomes a Terminal Blocker. This tolerates delayed recovery and possible duplicate startup work in exchange for eliminating indefinite queue stalls and routine human monitoring when the Mac mini or runner goes offline.
