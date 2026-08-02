# Security policy

## Supported version

The latest published SkillManager Plugin version receives security fixes.

## Reporting a vulnerability

Please open a minimal GitHub issue asking for a private contact path. Do not post tokens, cookies, private Skill contents, local control credentials, full home-directory paths, or exploit details in a public issue.

SkillManager binds its Dashboard to `127.0.0.1`, uses short-lived single-use launch links, stores optional GitHub credentials in the operating-system credential store, and requires preview/confirmation for filesystem mutations. A report should state which boundary can be bypassed and include a redacted reproduction.
