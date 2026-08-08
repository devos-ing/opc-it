# Keep orchestration independent from the scheduler

GitHub Actions will schedule version-one work, but reusable OPC CLI commands will implement the claim, execute, verify, recover, and publish state transitions. Workflows will remain thin adapters that pass event context and job-scoped credentials into this Orchestration Core. This adds a stable command boundary and local test surface in exchange for slightly more packaging work, while allowing a future Mac mini daemon or another scheduler to invoke the same behavior without rewriting the delivery system.
