# Privacy

skill-scope is local-first:

- Policy records, audit logs, trash, and the managed Skill library live under the local data
  directory (`~/Library/Application Support/SkillManager/policy` and `.../skills` on macOS, or
  `SKILL_SCOPE_DATA_DIR`).
- No telemetry, no analytics, no cloud sync. No personal data leaves the machine.
- Network is used only when the user explicitly asks to open SkillsMP or install a Skill from a
  user-specified SkillsMP page / GitHub repository. Downloads are copied as files and never executed.
- Opening SkillsMP uses the system default browser and sends no local data.
