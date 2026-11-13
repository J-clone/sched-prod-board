---
id: SCHED-4513
title: Board refreshes itself
status: ready
plan: R4
---

Today the board only changes when someone reloads the page. Refresh it every 2 seconds while it is open
(`fetchIncidents()` hands back what is current).

Acceptance: leave the board open; it stays current without a reload.
