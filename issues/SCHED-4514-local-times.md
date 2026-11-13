---
id: SCHED-4514
title: Times in the viewer's local time
status: ready
plan: R5
---

Follow-up to #4471. The board prints raw UTC (`2026-11-12T03:03:00.000Z`). On-call reads it in their own
time zone and gets it wrong.

- Show each incident's time in the viewer's local time.
- Day before month for EU locales (dd/mm); keep the full UTC value in the `<time datetime>` attribute.

Acceptance: a viewer in Auckland and one in Berlin each see the time in their own zone, in their own order.
