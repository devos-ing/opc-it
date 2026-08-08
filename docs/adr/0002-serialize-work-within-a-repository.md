# Serialize work within a repository

Only one Work Claim may be active in a repository, and its recovery chain keeps priority over newly approved work. This deliberately trades throughput for current-base execution, predictable evidence, and fewer conflicting pull requests; parallel work is deferred until the system can prove task independence and manage conflicts safely.
