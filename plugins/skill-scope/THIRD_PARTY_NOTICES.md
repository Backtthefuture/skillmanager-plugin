# Third-party notices

## SkillManager (MIT)

skill-scope is a standalone derivative of
[SkillManager](https://github.com/Backtthefuture/skillmanager) by Backtthefuture (MIT).
The policy storage layout, transaction/rollback design, and initial implementation were derived
from SkillManager and were subsequently reworked into a dependency-free, two-layer
(global/thread) plugin. The original MIT license text is included in `LICENSE`.

## Runtime dependencies

skill-scope has no runtime dependencies. It uses only the Node.js standard library
(`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`, global `fetch`).
