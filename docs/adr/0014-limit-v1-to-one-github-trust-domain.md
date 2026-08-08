# Limit v1 to one GitHub Trust Domain

Version one will onboard only private repositories under the same GitHub owner or organization as the `OPC` Control Repository. Target Repositories will call the approved reusable workflow version and use their repository-scoped `GITHUB_TOKEN`; version one will not depend on a personal access token or a custom GitHub App. This excludes cross-owner and cross-organization repositories in exchange for simpler credential rotation, narrower permissions, and fewer authentication components. Cross-domain support may add a GitHub App in a later version.
