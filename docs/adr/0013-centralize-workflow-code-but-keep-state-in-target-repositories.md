# Centralize workflow code but keep state in Target Repositories

The `OPC` Control Repository will version reusable GitHub workflows, a bundled private JavaScript Action, Issue schemas, validators, and recovery logic. Distribution uses GitHub's same-owner or same-organization private Action and reusable-workflow sharing, never a Target Repository token checking out the private Control Repository.

Each release records two immutable commits: `control_action_sha` identifies the bundled Action, then `control_workflow_sha` identifies a reusable workflow rendered to call that Action SHA. Producing the Action commit first avoids a self-referential workflow commit. Target Repositories pin the workflow SHA, while their Delivery lifecycle workflow pins the Action SHA. Version one does not add a PAT, GitHub App, database, Redis, or external queue.

Each Target Repository contains only its Repository Policy, thin caller workflow, Delivery lifecycle workflow, and Issue template. Its GitHub Issues, labels, Actions records, branches, and pull requests remain the sole durable state for that repository. This duplicates a small onboarding surface across repositories in exchange for centralized behavior, local auditability and permissions, and fewer services to operate.
