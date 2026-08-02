# SkillManager Privacy

SkillManager is local-first. Its Dashboard binds to `127.0.0.1`, and its MCP tools inspect Skill metadata on the user's machine.

- Skill bodies and supporting-file contents are not returned by default through MCP.
- Absolute home paths, local control credentials, session cookies, and GitHub tokens are excluded from MCP and diagnostic output.
- A GitHub token entered in the local Dashboard is stored in the operating system credential store; the local config keeps only a credential reference.
- Git synchronization is optional and runs only after an explicit browser preview and confirmation.
- Skill edits, replacements, and deletions use server-bound plans with stale-state checks and recovery snapshots or trash entries.

SkillManager does not operate a hosted data-collection service. Network access occurs only for features the user invokes, such as optional GitHub synchronization.
